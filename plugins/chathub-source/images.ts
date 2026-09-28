import type { GenerationRequest } from "@heimdall/contracts";
import { base64ToBytes, bytesToBase64 } from "@heimdall/contracts";
import { CHATHUB_ENDPOINT, type MessageAnnotation } from "./protocol/mod.ts";

export interface ChatHubImage {
    mediaType: string;
    data: Uint8Array;
}

/** Copilot's per-turn GptV upload cap; extra images past this are dropped. */
const MAX_IMAGES = 10;

const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Collects inline images from the newest user message. ChatHub attaches images
 * to the turn being sent, so only the latest user turn's images are uploaded;
 * earlier turns already live server-side on a reused conversation. Remote-URL
 * images with no inline bytes are skipped — the gateway does not fetch
 * arbitrary user-supplied URLs (SSRF), and the chat UI always sends base64.
 */
export function collectImages(request: GenerationRequest): ChatHubImage[] {
    let lastUser: GenerationRequest["messages"][number] | undefined;
    for (const message of request.messages) {
        if (message.role === "user") lastUser = message;
    }
    if (!lastUser) return [];
    const images: ChatHubImage[] = [];
    for (const part of lastUser.parts) {
        if (part.type !== "image") continue;
        let data = part.source.data;
        let mediaType = part.source.mediaType;
        // A base64 data: URI carries the same bytes; parse it so callers that
        // pass the whole image in `uri` (no split `data`) still upload.
        if (!data && part.source.uri?.startsWith("data:")) {
            const comma = part.source.uri.indexOf(",");
            const semi = part.source.uri.indexOf(";");
            if (comma > 0) {
                data = base64ToBytes(part.source.uri.slice(comma + 1));
                if (semi > 5 && semi < comma) {
                    mediaType = part.source.uri.slice(5, semi);
                }
            }
        }
        if (!data) continue; // remote URL: not fetched
        images.push({ mediaType: mediaType || "image/png", data });
        if (images.length >= MAX_IMAGES) break;
    }
    return images;
}

/** Derives the HTTPS UploadFile endpoint from the ws(s) ChatHub endpoint. */
export function uploadFileEndpoint(endpoint = CHATHUB_ENDPOINT): string {
    let base = endpoint;
    if (base.startsWith("wss:")) base = "https:" + base.slice(4);
    else if (base.startsWith("ws:")) base = "http:" + base.slice(3);
    base = base.replace(/\/+$/, "");
    return /\/Chathub$/i.test(base)
        ? base.replace(/\/Chathub$/i, "/UploadFile")
        : base + "/UploadFile";
}

interface UploadResponse {
    docId?: string;
    fileName?: string;
    fileType?: string;
    result?: { value?: string };
}

export interface UploadParams {
    accessToken: string;
    conversationId: string;
    scenario?: string;
    endpoint?: string;
}

/**
 * Uploads each image to Copilot's UploadFile endpoint and returns the
 * `messageAnnotations` that reference them on the chat turn.
 *
 * Wire shape mirrors the browser / reference-gateway capture: an
 * `application/x-www-form-urlencoded` body (multipart is rejected with HTTP 400
 * InvalidRequest) whose `FileBase64` field holds the full `data:` URL, gated by
 * the `X-Variants: feature.EnableImageSupportInUploadFile` header. Each success
 * yields a `docId` that is attached as an `ImageFile` annotation.
 */
export async function uploadImages(
    fetchImpl: typeof fetch,
    params: UploadParams,
    images: readonly ChatHubImage[],
    signal: AbortSignal,
): Promise<MessageAnnotation[]> {
    const url = uploadFileEndpoint(params.endpoint);
    const annotations: MessageAnnotation[] = [];
    for (const image of images) {
        signal.throwIfAborted();
        const dataUrl = `data:${image.mediaType};base64,${
            bytesToBase64(image.data)
        }`;
        const form = new URLSearchParams();
        form.set("scenario", "UploadImage");
        form.set("conversationId", params.conversationId);
        form.set("FileBase64", dataUrl);
        form.append("optionsSets", "cwcgptvsan");
        form.append(
            "optionsSets",
            "flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch",
        );
        const response = await fetchImpl(url, {
            method: "POST",
            signal,
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": `Bearer ${params.accessToken}`,
                "Accept": "application/json",
                "X-Variants": "feature.EnableImageSupportInUploadFile",
                "X-Scenario": params.scenario?.trim() ||
                    "OfficeWebIncludedCopilot",
                "Origin": "https://m365.cloud.microsoft",
                "Referer": "https://m365.cloud.microsoft/",
                "User-Agent": BROWSER_UA,
            },
            body: form.toString(),
        });
        const body = await response.text();
        if (!response.ok) {
            throw new Error(
                `ChatHub image upload failed (HTTP ${response.status}): ${
                    body.slice(0, 200)
                }`,
            );
        }
        let parsed: UploadResponse;
        try {
            parsed = JSON.parse(body) as UploadResponse;
        } catch {
            throw new Error(
                "ChatHub image upload returned a non-JSON response",
            );
        }
        if (
            !parsed.docId ||
            (parsed.result?.value && parsed.result.value !== "Success")
        ) {
            throw new Error(
                `ChatHub image upload was not accepted: ${body.slice(0, 200)}`,
            );
        }
        let fileType = (parsed.fileType ?? "").replace(/^\./, "").toLowerCase();
        if (!fileType) {
            fileType = image.mediaType.replace(/^image\//, "").toLowerCase();
        }
        if (!fileType || fileType === "image" || fileType === "*") {
            fileType = "jpg";
        }
        // ChatHub's ImageFile annotation labels JPEG uploads "jpg".
        if (fileType === "jpeg") fileType = "jpg";
        annotations.push({
            id: parsed.docId,
            messageAnnotationMetadata: {
                "@type": "File",
                annotationType: "File",
                fileType,
                fileName: parsed.fileName || `image.${fileType}`,
            },
            messageAnnotationType: "ImageFile",
        });
    }
    return annotations;
}

/** Hosts Copilot serves generated images from; anything else is not fetched. */
const GENERATED_IMAGE_HOSTS = [
    ".officeapps.live.com",
    ".office.com",
    ".cloud.microsoft",
];

const MAX_GENERATED_BYTES = 10 * 1024 * 1024;

function isGeneratedImageHost(url: URL): boolean {
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return GENERATED_IMAGE_HOSTS.some((suffix) =>
        host === suffix.slice(1) || host.endsWith(suffix)
    );
}

/**
 * Downloads Copilot-generated images to raw bytes so the source can hand the
 * kernel a buffer (never base64). URLs come from the upstream response and
 * carry their own short-lived `fileToken`, so no extra auth is added; only
 * Copilot-owned hosts are fetched and a failed download is skipped, never fatal.
 */
export async function downloadGeneratedImages(
    fetchImpl: typeof fetch,
    urls: readonly string[],
    signal: AbortSignal,
): Promise<ChatHubImage[]> {
    const images: ChatHubImage[] = [];
    for (const raw of urls) {
        if (images.length >= MAX_IMAGES) break;
        signal.throwIfAborted();
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            continue;
        }
        if (!isGeneratedImageHost(url)) continue;
        try {
            const response = await fetchImpl(url, { signal });
            if (!response.ok) continue;
            const buffer = await response.arrayBuffer();
            if (
                buffer.byteLength === 0 ||
                buffer.byteLength > MAX_GENERATED_BYTES
            ) {
                continue;
            }
            const mediaType = (response.headers.get("content-type") ?? "")
                .split(";")[0]!.trim() || "image/png";
            if (!mediaType.startsWith("image/")) continue;
            images.push({ mediaType, data: new Uint8Array(buffer) });
        } catch {
            // A single failed download must not sink the text answer.
            continue;
        }
    }
    return images;
}

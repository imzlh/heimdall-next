import {
    base64ToBytes,
    type ContentPart,
    type JsonValue,
} from "@heimdall/contracts";
import { ProtocolError } from "@heimdall/contracts";
import {
    asObject,
    audioMediaType,
    dataMediaType,
    nonEmptyOrBlankString,
    nonEmptyString,
    rawExtensions,
    requireObject,
    stripDataUrl,
    unknownFields,
} from "../wire.ts";

export function parseContent(
    value: JsonValue | undefined,
    messageId: string,
    dialect: "chat" | "responses",
): ContentPart[] {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") {
        return [{ id: `${messageId}:text:0`, type: "text", text: value }];
    }
    if (!Array.isArray(value)) {
        return [{ id: `${messageId}:json:0`, type: "json", value }];
    }
    return value.map((item, index) =>
        parseContentPart(item, `${messageId}:part:${index}`, dialect)
    );
}

export function parseContentPart(
    value: JsonValue,
    id: string,
    dialect: "chat" | "responses",
): ContentPart {
    const wire = requireObject(value, "content parts must be objects");
    const type = nonEmptyString(wire.type, "content part requires a type");
    if (type === "text" || type === "input_text" || type === "output_text") {
        return {
            id,
            type: "text",
            text: nonEmptyOrBlankString(
                wire.text,
                `${type}.text must be a string`,
            ),
            extensions: rawExtensions(
                unknownFields(wire, new Set(["type", "text"])),
            ),
        };
    }
    if (type === "refusal") {
        return {
            id,
            type: "refusal",
            text: nonEmptyOrBlankString(
                wire.refusal,
                "refusal must be a string",
            ),
        };
    }
    if (type === "image_url" || type === "input_image") {
        const image = type === "image_url"
            ? wire.image_url
            : wire.image_url ?? wire.file_id;
        const imageObject = asObject(image);
        const uri = typeof image === "string"
            ? image
            : typeof imageObject?.url === "string"
            ? imageObject.url
            : typeof wire.file_id === "string"
            ? `openai-file:${wire.file_id}`
            : undefined;
        if (!uri) {
            throw new ProtocolError(
                400,
                `${type} requires an image URL or file id`,
            );
        }
        const detail = imageObject?.detail ?? wire.detail;
        return {
            id,
            type: "image",
            source: { uri, mediaType: dataMediaType(uri) ?? "image/*" },
            detail: detail === "low" || detail === "high" || detail === "auto"
                ? detail
                : undefined,
            extensions: { raw: wire },
        };
    }
    if (type === "input_audio") {
        const audio = requireObject(
            wire.input_audio,
            "input_audio is required",
        );
        const data = nonEmptyString(audio.data, "input_audio.data is required");
        const format = nonEmptyString(
            audio.format,
            "input_audio.format is required",
        );
        return {
            id,
            type: "audio",
            source: {
                data: base64ToBytes(data),
                mediaType: audioMediaType(format),
            },
            extensions: { raw: wire },
        };
    }
    if (type === "file" || type === "input_file") {
        const file = asObject(wire.file) ?? wire;
        const uri = typeof file.file_id === "string"
            ? `openai-file:${file.file_id}`
            : typeof file.file_url === "string"
            ? file.file_url
            : undefined;
        const dataBase64 = typeof file.file_data === "string"
            ? stripDataUrl(file.file_data)
            : undefined;
        if (!uri && !dataBase64) {
            throw new ProtocolError(
                400,
                `${type} requires file_id, file_url, or file_data`,
            );
        }
        return {
            id,
            type: "document",
            source: {
                uri,
                ...(dataBase64 === undefined
                    ? {}
                    : { data: base64ToBytes(dataBase64) }),
                mediaType: typeof file.media_type === "string"
                    ? file.media_type
                    : dataMediaType(
                        typeof file.file_data === "string"
                            ? file.file_data
                            : "",
                    ) ?? "application/octet-stream",
            },
            title: typeof file.filename === "string"
                ? file.filename
                : undefined,
            extensions: { raw: wire },
        };
    }
    return {
        id,
        type: "custom",
        name: `${dialect}.${type}`,
        value: wire,
        extensions: { raw: wire },
    };
}

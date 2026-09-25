import type { JsonValue, OperationRequest } from "@heimdall/contracts";
import { ProtocolError, type RequestContext } from "@heimdall/contracts";
import type { OpenAIDialect } from "../contract.ts";

const JSON_LIMIT = 1_048_576;
const MULTIPART_LIMIT = 20_971_520;
const FILE_LIMIT = 15_728_640;
const MAX_PARTS = 256;

const SECRET_KEY =
    /^(api[-_]?key|authorization|proxy[-_]?authorization|password|passwd|secret|client[-_]?secret|access[-_]?token|refresh[-_]?token|id[-_]?token|credential|credentials|cookie|set-cookie|x-api-key|token)$/i;

interface SimpleSpec {
    readonly operation: string;
    readonly vocabulary: string;
    readonly streaming: boolean;
}

const SIMPLE_SPECS: Partial<Record<OpenAIDialect, SimpleSpec>> = {
    completions: {
        operation: "completion.create",
        vocabulary: "openai.completion",
        streaming: true,
    },
    embeddings: {
        operation: "embedding.create",
        vocabulary: "openai.embedding",
        streaming: false,
    },
    "images.generations": {
        operation: "image.generate",
        vocabulary: "openai.image.generate",
        streaming: false,
    },
};

/**
 * Parse the OpenAI endpoints that are not chat or responses.
 *
 * The result is a custom HIP payload. The kernel routes on `operation` and
 * never sees the client JSON. Credential-shaped fields are rejected.
 */
export async function parseSimpleOpenAIRequest(
    context: RequestContext,
    dialect: OpenAIDialect,
): Promise<OperationRequest> {
    if (dialect === "images.edits") return await parseImageEdit(context);
    const spec = SIMPLE_SPECS[dialect];
    if (spec === undefined) {
        throw new ProtocolError(500, `unsupported OpenAI dialect ${dialect}`);
    }
    if (context.route.operation !== spec.operation) {
        throw new ProtocolError(
            500,
            `route operation does not match ${spec.operation}`,
        );
    }
    const body = await readJson(context.request);
    const model = requiredModel(body.model);
    const stream = body.stream === true;
    if (body.stream !== undefined && typeof body.stream !== "boolean") {
        throw new ProtocolError(400, "stream must be a boolean");
    }
    const value = sanitize(body) as Record<string, JsonValue>;
    if (!spec.streaming) delete value.stream;
    value.model = model;
    return {
        version: 1,
        requestId: context.requestId,
        operation: spec.operation,
        payload: { vocabulary: spec.vocabulary, value },
        traits: {
            model,
            streaming: spec.streaming && stream,
            idempotent: spec.operation === "embedding.create",
        },
    };
}

async function parseImageEdit(
    context: RequestContext,
): Promise<OperationRequest> {
    if (context.route.operation !== "image.edit") {
        throw new ProtocolError(
            500,
            "route operation does not match image.edit",
        );
    }
    const type = context.request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data(?:;|$)/i.test(type)) {
        throw new ProtocolError(
            400,
            "image edits require multipart/form-data",
        );
    }
    const length = contentLength(context.request);
    if (length !== undefined && length > MULTIPART_LIMIT) {
        throw new ProtocolError(
            413,
            "request body is too large",
            "request_too_large",
        );
    }
    let form: FormData;
    try {
        form = await context.request.formData();
    } catch {
        throw new ProtocolError(400, "invalid multipart image edit request");
    }
    let parts = 0;
    let prompt = "";
    let model = "";
    const fields: Record<string, JsonValue> = {};
    const images: JsonValue[] = [];
    let mask: JsonValue | undefined;
    const files: JsonValue[] = [];
    for (const [key, entry] of form.entries()) {
        parts += 1;
        if (parts > MAX_PARTS) {
            throw new ProtocolError(
                400,
                "invalid multipart image edit request",
            );
        }
        rejectKey(key);
        if (entry instanceof File) {
            const file = await readFile(key, entry);
            if (file === undefined) continue;
            if (key === "image" || key === "image[]") images.push(file);
            else if (key === "mask") mask = file;
            else files.push(file);
            continue;
        }
        if (key === "prompt") prompt = entry.trim();
        else if (key === "model") model = entry.trim();
        else fields[key] = entry;
    }
    if (prompt.length === 0 || images.length === 0) {
        throw new ProtocolError(
            400,
            "multipart image edit requires a non-empty prompt and image file",
        );
    }
    if (model.length === 0) {
        throw new ProtocolError(400, "model is required");
    }
    const value: Record<string, JsonValue> = {
        model,
        prompt,
        images,
        ...(mask === undefined ? {} : { mask }),
        ...(files.length === 0 ? {} : { files }),
        ...(Object.keys(fields).length === 0 ? {} : { fields }),
    };
    return {
        version: 1,
        requestId: context.requestId,
        operation: "image.edit",
        payload: { vocabulary: "openai.image.edit", value },
        traits: { model, streaming: false, idempotent: false },
    };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
    const type = request.headers.get("content-type") ?? "";
    if (
        type.length > 0 && !type.includes("application/json") &&
        !type.includes("+json")
    ) {
        throw new ProtocolError(400, "request body must be JSON");
    }
    const length = contentLength(request);
    if (length !== undefined && length > JSON_LIMIT) {
        throw new ProtocolError(
            413,
            "request body is too large",
            "request_too_large",
        );
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > JSON_LIMIT) {
        throw new ProtocolError(
            413,
            "request body is too large",
            "request_too_large",
        );
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new ProtocolError(400, "request body must be valid JSON");
    }
    if (!isRecord(parsed)) {
        throw new ProtocolError(400, "request body must be an object");
    }
    return parsed;
}

async function readFile(
    field: string,
    file: File,
): Promise<JsonValue | undefined> {
    if (file.size === 0) return undefined;
    if (file.size > FILE_LIMIT) {
        throw new ProtocolError(
            413,
            "request body is too large",
            "request_too_large",
        );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return {
        field,
        filename: file.name.length > 0 ? file.name : "image",
        mediaType: file.type.length > 0
            ? file.type
            : "application/octet-stream",
        dataBase64: encodeBase64(bytes),
    };
}

function sanitize(value: unknown): JsonValue {
    if (
        value === null || typeof value === "string" ||
        typeof value === "boolean"
    ) {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new ProtocolError(
                400,
                "request body contains a non-finite number",
            );
        }
        return value;
    }
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
    if (!isRecord(value)) {
        throw new ProtocolError(400, "request body must be JSON");
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
        rejectKey(key);
        output[key] = sanitize(entry);
    }
    return output;
}

function requiredModel(value: unknown): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new ProtocolError(400, "model is required");
    }
    return value.trim();
}

function rejectKey(key: string): void {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new ProtocolError(
            400,
            `${key} cannot be sent in the request body`,
        );
    }
    if (SECRET_KEY.test(key)) {
        throw new ProtocolError(
            400,
            `${key} cannot be sent in the request body`,
        );
    }
}

function contentLength(request: Request): number | undefined {
    const raw = request.headers.get("content-length");
    if (raw === null || raw.length === 0) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
}

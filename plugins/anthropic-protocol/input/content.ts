import {
    type ContentPart,
    type JsonObject,
    type JsonValue,
    type Message,
} from "@heimdall/contracts";
import { ProtocolError } from "@heimdall/contracts";
import {
    asObject,
    encodeUtf8,
    isJsonValue,
    nonEmptyOrBlankString,
    nonEmptyString,
    optionalString,
    rawExtensions,
    requireObject,
    sanitizeJson,
    unknownFields,
} from "../shared.ts";

export function parseMessages(
    value: JsonValue | undefined,
    requestId: string,
): Message[] {
    if (!Array.isArray(value)) {
        throw new ProtocolError(400, "messages must be an array");
    }
    if (value.length === 0) {
        throw new ProtocolError(400, "messages must not be empty");
    }
    const ids = new Set<string>();
    return value.map((item, index) => {
        const wire = requireObject(item, "each message must be an object");
        const role = nonEmptyString(wire.role, "each message requires a role");
        if (role !== "user" && role !== "assistant") {
            throw new ProtocolError(
                400,
                "message role must be user or assistant",
            );
        }
        const id = typeof wire.id === "string" && wire.id.length > 0
            ? wire.id
            : `${requestId}:input:${index}`;
        if (ids.has(id)) {
            throw new ProtocolError(400, `duplicate message id: ${id}`);
        }
        ids.add(id);
        const parts = parseContent(wire.content, id);
        const raw = unknownFields(wire, new Set(["role", "content", "id"]));
        return {
            id,
            role,
            parts,
            ...(Object.keys(raw).length > 0 ? { extensions: { raw } } : {}),
        };
    });
}

export function parseContent(
    value: JsonValue | undefined,
    messageId: string,
): ContentPart[] {
    if (value === undefined || value === null) return [];
    if (typeof value === "string") {
        return [{ id: `${messageId}:text:0`, type: "text", text: value }];
    }
    if (!Array.isArray(value)) {
        throw new ProtocolError(
            400,
            "message content must be a string or array",
        );
    }
    return value.map((item, index) =>
        parseContentBlock(item, `${messageId}:part:${index}`)
    );
}

export function parseContentBlock(value: JsonValue, id: string): ContentPart {
    const wire = requireObject(value, "content blocks must be objects");
    const type = nonEmptyString(wire.type, "content block requires a type");
    if (type === "text") {
        return {
            id,
            type: "text",
            text: nonEmptyOrBlankString(wire.text, "text block requires text"),
            extensions: rawExtensions(
                unknownFields(wire, new Set(["type", "text"])),
            ),
        };
    }
    if (type === "image") return parseImage(wire, id);
    if (type === "document") return parseDocument(wire, id);
    if (type === "tool_use") {
        const callId = nonEmptyString(wire.id, "tool_use requires id");
        const name = nonEmptyString(wire.name, "tool_use requires name");
        const input = wire.input === undefined ? {} : wire.input;
        if (!isJsonValue(input)) {
            throw new ProtocolError(400, "tool_use.input must be JSON");
        }
        return {
            id,
            type: "tool_call",
            callId,
            name,
            argumentsText: JSON.stringify(input),
            arguments: input,
            status: "completed",
            done: true,
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    if (type === "tool_result") {
        const callId = nonEmptyString(
            wire.tool_use_id,
            "tool_result requires tool_use_id",
        );
        if (wire.is_error !== undefined && typeof wire.is_error !== "boolean") {
            throw new ProtocolError(
                400,
                "tool_result.is_error must be a boolean",
            );
        }
        const nested = parseContent(wire.content, `${id}:result`);
        const result = isJsonValue(wire.content) ? wire.content : undefined;
        return {
            id,
            type: "tool_result",
            callId,
            parts: nested,
            ...(result === undefined ? {} : { result }),
            isError: wire.is_error === true,
            done: true,
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    if (type === "thinking" || type === "redacted_thinking") {
        const text = type === "thinking"
            ? nonEmptyOrBlankString(wire.thinking, "thinking must be a string")
            : "";
        if (type === "redacted_thinking" && wire.data !== undefined) {
            nonEmptyString(
                wire.data,
                "redacted_thinking.data must be a string",
            );
        }
        return {
            id,
            type: "reasoning",
            text,
            signature: optionalString(wire.signature, "signature"),
            visibility: type === "redacted_thinking" ? "redacted" : "private",
            done: true,
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    return {
        id,
        type: "custom",
        name: `anthropic.${type}`,
        value: sanitizeJson(wire),
        extensions: { raw: sanitizeJson(wire) as JsonObject },
    };
}

function parseImage(wire: JsonObject, id: string): ContentPart {
    const source = requireObject(wire.source, "image source is required");
    const sourceType = nonEmptyString(
        source.type,
        "image source type is required",
    );
    if (sourceType === "base64") {
        return {
            id,
            type: "image",
            source: {
                dataBase64: nonEmptyString(
                    source.data,
                    "image source data is required",
                ),
                mediaType: nonEmptyString(
                    source.media_type,
                    "image media_type is required",
                ),
            },
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    if (sourceType === "url") {
        return {
            id,
            type: "image",
            source: {
                uri: nonEmptyString(source.url, "image source url is required"),
                mediaType: typeof source.media_type === "string"
                    ? source.media_type
                    : "image/*",
            },
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    throw new ProtocolError(
        400,
        `unsupported image source type: ${sourceType}`,
    );
}

function parseDocument(wire: JsonObject, id: string): ContentPart {
    const source = asObject(wire.source) ?? wire;
    const sourceType = typeof source.type === "string"
        ? source.type
        : undefined;
    const mediaType = typeof source.media_type === "string"
        ? source.media_type
        : "application/octet-stream";
    if (sourceType === "base64" && typeof source.data === "string") {
        return {
            id,
            type: "document",
            source: { dataBase64: source.data, mediaType },
            title: optionalString(wire.title, "title"),
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    if (sourceType === "url" && typeof source.url === "string") {
        return {
            id,
            type: "document",
            source: { uri: source.url, mediaType },
            title: optionalString(wire.title, "title"),
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    if (sourceType === "text" && typeof source.data === "string") {
        return {
            id,
            type: "document",
            source: {
                dataBase64: encodeUtf8(source.data),
                mediaType: "text/plain",
            },
            title: optionalString(wire.title, "title"),
            extensions: { raw: sanitizeJson(wire) as JsonObject },
        };
    }
    throw new ProtocolError(400, "unsupported document source");
}

import { type JsonValue, type Message } from "@heimdall/contracts";
import { ProtocolError } from "@heimdall/contracts";
import { parseContent } from "./content.ts";
import { parseToolCall } from "./options.ts";
import {
    asObject,
    isJsonValue,
    nonEmptyString,
    optionalString,
    rawExtensions,
    requireObject,
    unknownFields,
} from "../wire.ts";

export function parseChatMessages(
    value: JsonValue | undefined,
    requestId: string,
): Message[] {
    if (!Array.isArray(value)) {
        throw new ProtocolError(400, "messages must be an array");
    }
    return value.map((item, index) =>
        parseChatMessage(item, `${requestId}:input:${index}`)
    );
}

export function parseChatMessage(
    value: JsonValue,
    fallbackId: string,
): Message {
    const wire = requireObject(value, "each message must be an object");
    const role = nonEmptyString(wire.role, "each message requires a role");
    const id = typeof wire.id === "string" && wire.id.length > 0
        ? wire.id
        : fallbackId;
    let parts = parseContent(wire.content, id, "chat");

    if (role === "tool") {
        const callId = nonEmptyString(
            wire.tool_call_id,
            "tool messages require tool_call_id",
        );
        parts = [{
            id: `${id}:tool-result`,
            type: "tool_result",
            callId,
            parts,
            done: true,
        }];
    }

    if (Array.isArray(wire.tool_calls)) {
        parts = [
            ...parts,
            ...wire.tool_calls.map((call, index) =>
                parseToolCall(call, `${id}:tool-call:${index}`)
            ),
        ];
    }
    if (typeof wire.refusal === "string") {
        parts = [...parts, {
            id: `${id}:refusal`,
            type: "refusal",
            text: wire.refusal,
        }];
    }

    const raw = unknownFields(
        wire,
        new Set([
            "id",
            "role",
            "content",
            "name",
            "tool_calls",
            "tool_call_id",
            "refusal",
        ]),
    );
    return {
        id,
        role,
        parts,
        name: optionalString(wire.name, "message.name"),
        extensions: rawExtensions(raw),
    };
}

export function parseResponsesInput(
    value: JsonValue | undefined,
    requestId: string,
): Message[] {
    if (typeof value === "string") {
        return [{
            id: `${requestId}:input:0`,
            role: "user",
            parts: [{
                id: `${requestId}:input:0:text:0`,
                type: "text",
                text: value,
            }],
        }];
    }
    if (!Array.isArray(value)) {
        throw new ProtocolError(400, "input must be a string or an array");
    }
    return value.map((item, index) => {
        const id = `${requestId}:input:${index}`;
        if (typeof item === "string") {
            return {
                id,
                role: "user",
                parts: [{ id: `${id}:text:0`, type: "text", text: item }],
            };
        }
        const wire = requireObject(item, "each input item must be an object");
        const itemId = typeof wire.id === "string" && wire.id.length > 0
            ? wire.id
            : id;
        const type = typeof wire.type === "string" ? wire.type : "message";

        if (type === "message") {
            const role = nonEmptyString(
                wire.role,
                "input message requires a role",
            );
            const raw = unknownFields(
                wire,
                new Set(["id", "type", "role", "content"]),
            );
            return {
                id: itemId,
                role,
                parts: parseContent(wire.content, itemId, "responses"),
                extensions: rawExtensions(raw),
            };
        }
        if (type === "function_call") {
            return {
                id: itemId,
                role: "assistant",
                parts: [parseToolCall(wire, `${itemId}:tool-call`)],
            };
        }
        if (type === "function_call_output") {
            const callId = nonEmptyString(
                wire.call_id,
                "function_call_output requires call_id",
            );
            const nested = parseContent(wire.output, itemId, "responses");
            return {
                id: itemId,
                role: "tool",
                parts: [{
                    id: `${itemId}:tool-result`,
                    type: "tool_result",
                    callId,
                    parts: nested,
                    result: isJsonValue(wire.output) ? wire.output : undefined,
                    done: true,
                }],
            };
        }
        if (type === "reasoning") {
            const summary = Array.isArray(wire.summary)
                ? wire.summary.flatMap((part) => {
                    const item = asObject(part);
                    return typeof item?.text === "string" ? [item.text] : [];
                }).join("")
                : "";
            return {
                id: itemId,
                role: "assistant",
                parts: [{
                    id: `${itemId}:reasoning`,
                    type: "reasoning",
                    text: summary,
                    signature: optionalString(
                        wire.encrypted_content,
                        "encrypted_content",
                    ),
                    visibility: "private",
                    extensions: { raw: wire },
                }],
            };
        }
        return {
            id: itemId,
            role: "user",
            parts: [{
                id: `${itemId}:custom`,
                type: "custom",
                name: type,
                value: wire,
                extensions: { raw: wire },
            }],
        };
    });
}

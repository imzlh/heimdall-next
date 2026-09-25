import type { ChatMessage, JsonObject } from "./types.ts";

export type ChatHubStreamEventKind = "text" | "progress" | "reasoning" | "tool";

export interface ChatHubStreamEvent {
    kind: ChatHubStreamEventKind;
    text?: string;
    messageType?: string;
    contentType?: string;
    toolName?: string;
    arguments?: unknown;
    raw: JsonObject;
}

function isRecord(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractToolFields(message: JsonObject): {
    name?: string;
    arguments?: unknown;
} {
    let name: string | undefined;
    for (const key of ["name", "toolName", "pluginName", "functionName"]) {
        if (typeof message[key] === "string" && message[key] !== "") {
            name = message[key] as string;
            break;
        }
    }

    let args: unknown;
    for (
        const key of ["arguments", "args", "parameters", "functionArguments"]
    ) {
        if (message[key] !== undefined && message[key] !== null) {
            args = message[key];
            break;
        }
    }

    return { name, arguments: args };
}

export function classifyUpdateMessages(
    messages: readonly unknown[],
): ChatHubStreamEvent[] {
    const events: ChatHubStreamEvent[] = [];

    for (const value of messages) {
        if (!isRecord(value)) continue;

        const text = typeof value.text === "string" ? value.text : "";
        const messageType = typeof value.messageType === "string"
            ? value.messageType
            : undefined;
        const contentType = typeof value.contentType === "string"
            ? value.contentType
            : undefined;
        const contentOrigin = typeof value.contentOrigin === "string"
            ? value.contentOrigin
            : undefined;

        let kind: ChatHubStreamEventKind = "text";
        if (
            messageType === "Progress" ||
            contentType === "SearchResults" ||
            contentType === "Code" ||
            contentType === "ToolCall"
        ) {
            kind = "progress";
        }
        if (
            contentOrigin === "ChainOfThoughtSummary" ||
            value.addToChainOfThought === true
        ) {
            kind = "reasoning";
        }

        const tool = extractToolFields(value);
        if (tool.name && tool.arguments !== undefined) kind = "tool";
        if (text === "" && kind === "text") continue;

        events.push({
            kind,
            text: text || undefined,
            messageType,
            contentType,
            toolName: tool.name,
            arguments: tool.arguments,
            raw: value,
        });
    }

    return events;
}

export function extractToolEvents(
    value: unknown,
    seen: Set<string> = new Set(),
): ChatHubStreamEvent[] {
    const events: ChatHubStreamEvent[] = [];

    const visit = (current: unknown): void => {
        if (Array.isArray(current)) {
            for (const item of current) visit(item);
            return;
        }
        if (!isRecord(current)) return;

        const tool = extractToolFields(current);
        if (tool.name && tool.arguments !== undefined) {
            const identity = JSON.stringify([tool.name, tool.arguments]);
            if (!seen.has(identity)) {
                seen.add(identity);
                events.push({
                    kind: "tool",
                    toolName: tool.name,
                    arguments: tool.arguments,
                    raw: current,
                });
            }
        }

        for (const nested of Object.values(current)) visit(nested);
    };

    visit(value);
    return events;
}

export function asChatMessages(value: unknown): ChatMessage[] {
    return Array.isArray(value) ? value.filter(isRecord) as ChatMessage[] : [];
}

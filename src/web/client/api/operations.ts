import { AdminApiError, payloadRecord, request } from "./transport.ts";
import type {
    JournalResponse,
    SourceProbeResult,
    UsageResponse,
} from "./types.ts";

export async function createChatConversation(): Promise<string> {
    const data = await request<{ conversation?: { id?: string } }>(
        "/api/chat/conversations",
        { method: "POST" },
    );
    const id = data.conversation?.id;
    if (!id) {
        throw new AdminApiError("conversation id missing", {
            code: "invalid_response",
        });
    }
    return id;
}

export async function sendChatMessage(
    conversationId: string,
    model: string,
    text: string,
): Promise<{ role: string; text: string }[]> {
    return readChatMessages(
        await request("/api/chat/message", {
            method: "POST",
            body: JSON.stringify({ conversationId, model, text }),
        }),
    );
}

export async function regenerateChat(
    conversationId: string,
    model: string,
): Promise<{ role: string; text: string }[]> {
    return readChatMessages(
        await request("/api/chat/regenerate", {
            method: "POST",
            body: JSON.stringify({ conversationId, model }),
        }),
    );
}

function readChatMessages(data: unknown): { role: string; text: string }[] {
    const body = payloadRecord(data);
    const messages = body?.messages;
    if (!Array.isArray(messages)) return [];
    return messages.map((item) => {
        const record = payloadRecord(item);
        return {
            role: typeof record?.role === "string" ? record.role : "assistant",
            text: typeof record?.text === "string" ? record.text : "",
        };
    });
}

export function setPluginEnabled(
    pluginId: string,
    enabled: boolean,
): Promise<unknown> {
    return request("/api/admin/plugin-state", {
        method: "POST",
        body: JSON.stringify({ pluginId, enabled }),
    });
}

export function loadRequests(
    { limit = 20, status = "", before = "" }: {
        limit?: number;
        status?: string;
        before?: string;
    } = {},
): Promise<JournalResponse> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (status) params.set("status", status);
    if (before) params.set("before", before);
    const query = params.toString();
    return request<JournalResponse>(
        `/api/admin/requests${query ? `?${query}` : ""}`,
    );
}

export function loadUsage(): Promise<UsageResponse> {
    return request<UsageResponse>("/api/admin/usage");
}

export function uninstallPlugin(pluginId: string): Promise<unknown> {
    return request("/api/admin/plugin", {
        method: "DELETE",
        body: JSON.stringify({ pluginId }),
    });
}

export function probeSource(sourceId: string): Promise<SourceProbeResult> {
    return request<SourceProbeResult>("/api/admin/source-probe", {
        method: "POST",
        body: JSON.stringify({ sourceId }),
    });
}

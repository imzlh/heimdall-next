import type { ChatConversation, ChatToolInfo } from "./chat.ts";
import { MAX_CHAT_TOOLS } from "./chat.ts";
import {
    parseUiContributions,
    safeUiAssetPath,
    type UiContext,
    type UiContribution,
    uiContributionKey,
    type UiPolicy,
} from "./ui.ts";

export const CHAT_TOOL_TOGGLE = "chat.tool.toggle";
export interface ChatExtensions {
    readonly contributions: readonly UiContribution[];
    readonly tools: readonly ChatToolInfo[];
    readonly policy: UiPolicy;
}
export const EMPTY_CHAT_EXTENSIONS: ChatExtensions = {
    contributions: [],
    tools: [],
    policy: {},
};
export function isChatSlot(slot: string): boolean {
    return slot === "chat.composer" || slot === "chat.sidebar";
}
export function projectChatTools(value: unknown): ChatToolInfo[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const tools: ChatToolInfo[] = [];
    for (const item of value) {
        if (
            !item || typeof item !== "object" || item.kind !== "tool" ||
            item.enabled !== true ||
            typeof item.id !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(item.id) ||
            seen.has(item.id)
        ) continue;
        seen.add(item.id);
        tools.push({
            id: item.id,
            name: typeof item.name === "string" && item.name.trim()
                ? item.name.slice(0, 80)
                : item.id,
            ...(typeof item.description === "string"
                ? { description: item.description.slice(0, 512) }
                : {}),
        });
        if (tools.length === MAX_CHAT_TOOLS) break;
    }
    return tools;
}

/** Tool metadata gets a generic control; a manifest may replace that slot's UI. */
export function buildChatExtensions(
    declarations: readonly UiContribution[],
    tools: readonly ChatToolInfo[],
    policy: UiPolicy = {},
): ChatExtensions {
    const contributions = declarations.filter((item) => isChatSlot(item.slot));
    for (const tool of tools) {
        if (
            contributions.some((item) =>
                item.pluginId === tool.id && item.slot === "chat.composer"
            )
        ) continue;
        let id = "host-tool-toggle";
        while (
            contributions.some((item) =>
                item.pluginId === tool.id && item.id === id
            )
        ) id += "-";
        contributions.push({
            pluginId: tool.id,
            id,
            slot: "chat.composer",
            title: tool.name.slice(0, 80) || tool.id,
            schema: {
                blocks: [{
                    kind: "toggle",
                    label: tool.name.slice(0, 80) || tool.id,
                    checked: true,
                    checkedFrom: ["tool", "enabled"],
                    disabledFrom: ["chat", "busy"],
                    action: { id: CHAT_TOOL_TOGGLE, payload: {} },
                }],
            },
        });
    }
    const toolIds = new Set(tools.map((tool) => tool.id));
    const allowedActions: Record<string, readonly string[]> = {};
    for (const contribution of contributions) {
        const key = uiContributionKey(contribution);
        // Chat currently exposes only a session-scoped capability toggle. A plugin
        // cannot obtain management actions by declaring an action with another id.
        if (toolIds.has(contribution.pluginId)) {
            allowedActions[key] = [CHAT_TOOL_TOGGLE];
        }
    }
    const approved = (
        entries: Readonly<Record<string, string>> | undefined,
        extension: "js" | "html",
    ) => Object.fromEntries(
        Object.entries(entries ?? {}).filter(([key, path]) =>
            contributions.some((item) => uiContributionKey(item) === key) &&
            safeUiAssetPath(path, extension)
        ),
    );
    return {
        contributions,
        tools,
        policy: {
            allowedActions,
            trustedModules: approved(policy.trustedModules, "js"),
            sandboxDocuments: approved(policy.sandboxDocuments, "html"),
        },
    };
}

/** Validate the live host response; runtime modules never define their own trust. */
export function parseChatExtensions(value: unknown): ChatExtensions {
    if (!value || typeof value !== "object") {
        throw new TypeError("Invalid chat extensions");
    }
    const input = value as Record<string, unknown>;
    if (!Array.isArray(input.tools)) throw new TypeError("Invalid chat tools");
    // Validate declarations separately so auto-generated controls do not use the
    // per-manifest contribution limit as the global installed-tool limit.
    if (
        !Array.isArray(input.contributions) || input.contributions.length > 256
    ) throw new TypeError("Invalid chat contributions");
    const contributions = input.contributions.flatMap((item) =>
        parseUiContributions([item])
    );
    const tools = projectChatTools(
        input.tools.map((tool) => ({ ...tool, kind: "tool", enabled: true })),
    );
    const rawPolicy = input.policy && typeof input.policy === "object"
        ? input.policy as UiPolicy
        : {};
    return buildChatExtensions(contributions, tools, rawPolicy);
}

/** No prompts, messages, drafts, attachments, credentials or peer-plugin state. */
export function chatUiContext(input: {
    readonly conversation: ChatConversation | null;
    readonly model: string;
    readonly messageCount: number;
    readonly busy: boolean;
    readonly pendingDisabledTools?: readonly string[];
    readonly tools: readonly ChatToolInfo[];
    readonly theme?: UiContext["theme"];
}, contribution: UiContribution): UiContext {
    const tool = input.tools.find((item) => item.id === contribution.pluginId);
    const enabled = Boolean(tool) &&
        !(input.conversation?.disabledTools ?? input.pendingDisabledTools ?? [])
            .includes(contribution.pluginId);
    return {
        locale: "zh",
        theme: input.theme ?? "system",
        ...(input.conversation
            ? { conversationId: input.conversation.id }
            : {}),
        data: {
            chat: {
                model: input.model,
                messageCount: input.messageCount,
                busy: input.busy,
            },
            ...(tool
                ? {
                    tool: {
                        id: tool.id,
                        name: tool.name,
                        enabled,
                        state: enabled ? "本会话已启用" : "本会话已停用",
                    },
                }
                : {}),
        },
    };
}

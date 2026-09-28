/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import type { ChatConversation } from "@heimdall/admin-contracts/chat.ts";
import { Dropdown } from "../forms/dropdown.tsx";

/** Leaf navigation also reaches preserved paths with no shared visible messages. */
export function ConversationBranches(
    { branches, disabled, onSelectBranch }: {
        branches: ChatConversation["branches"];
        disabled: boolean;
        onSelectBranch: (messageId: string) => void;
    },
) {
    if (!branches || branches.length < 2) return null;
    const selectedId = branches.find((branch) => branch.selected)?.messageId ??
        "";
    return (
        <div class="chat-settings-field">
            <span>
                历史分支 <small>{branches.length} 条</small>
            </span>
            <Dropdown
                value={selectedId}
                disabled={disabled}
                placeholder="选择历史分支"
                ariaLabel="历史分支"
                dataName="chat-conversation-branches"
                describedBy="chat-branches-hint"
                options={branches.map((branch, index) => ({
                    value: branch.messageId,
                    label: `${index + 1}. ${branch.label || "未命名分支"}`,
                    disabled: disabled || branch.selected,
                }))}
                onChange={(messageId) => {
                    if (!disabled && messageId !== selectedId) {
                        onSelectBranch(messageId);
                    }
                }}
            />
            <small class="chat-settings-meta" id="chat-branches-hint">
                查看保留的对话路径，当前输入会保留。
            </small>
        </div>
    );
}

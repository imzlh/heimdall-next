import { Icon } from "../src/web/shared/icons.tsx";

export const composerPreviewCss = `
.chat-preview-states { width: min(1100px, 100%); margin: 0 auto; padding: 48px 32px 72px; }
.chat-preview-states > h2 { font-size: 24px; letter-spacing: -.03em; }
.chat-preview-states > p { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.8; }
.chat-preview-state { margin-top: 28px; padding: 22px; border: 1px solid var(--border); border-radius: 24px; background: var(--bg); }
.chat-preview-state h3 { font-size: 14px; }
.chat-preview-state > p { margin: 5px 0 0; color: var(--muted); font-size: 12px; }
.chat-preview-state .chat-composer-region { position: relative; inset: auto; padding: 32px 0 14px; }
.chat-preview-state .chat-composer-hint { display: block; }
.chat-preview-state .chat-composer[data-preview-state="focus"],
.chat-preview-state .chat-composer[data-preview-state="long"] {
    width: min(720px, 100%);
    transform: translateY(-1px);
    border-color: color-mix(in srgb, var(--accent) 20%, var(--border));
    box-shadow: 0 10px 28px rgb(1 5 12 / 16%), 0 1px 0 rgb(255 255 255 / 5%) inset;
}
.chat-preview-state .chat-send[data-preview-ready="true"]:disabled {
    background: var(--button-bg);
    color: #fff;
    opacity: 1;
    box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 16%, transparent);
}
@media (max-width: 560px) {
    .chat-preview-states { padding: 32px 16px 48px; }
    .chat-preview-state { padding: 18px 12px; }
}
`;

const examples = [{
    state: "rest",
    title: "等待输入",
    description: "收拢为居中的轻巧胶囊，图片按钮与发送箭头留在同一行。",
    draft: "",
}, {
    state: "focus",
    title: "开始输入",
    description: "聚焦后向两侧展开，输入区域轻轻抬起，发送箭头亮起。",
    draft: "帮我整理一下周末的旅行安排。",
}, {
    state: "long",
    title: "多行内容",
    description:
        "文字增加时向上生长，底部位置保持稳定，工具按钮仍在同一块表面。",
    draft:
        "想找一个能慢慢散步的地方，最好靠近湖边。\n周六下午出发，周日晚饭前回来。\n不用塞满行程，留一点休息和发呆的时间。\n可以先帮我列一个简单的安排吗？",
}, {
    state: "streaming",
    title: "正在生成",
    description:
        "发送箭头切换为停止按钮，占用同一个圆形位置，输入框不会左右跳动。",
    draft: "",
}] as const;

/** Disabled design specimens: these do not connect to the chat API or pretend to send. */
export function ChatComposerStates() {
    return (
        <section
            id="composer-states"
            class="chat-preview-states"
            aria-labelledby="composer-states-title"
        >
            <h2 id="composer-states-title">灵动输入框</h2>
            <p>
                下方为四种静态状态样例，复用聊天页样式；控件已禁用，不连接会话。
                动画时序与实际键盘、触控体验需在运行中的聊天页验收。
            </p>
            {examples.map((example) => {
                const sending = example.state === "streaming";
                const id = `preview-draft-${example.state}`;
                const hintId = `${id}-hint`;
                return (
                    <article class="chat-preview-state">
                        <h3>{example.title}</h3>
                        <p>{example.description}</p>
                        <div class="chat-composer-region">
                            <form
                                class="chat-composer"
                                data-preview-state={example.state}
                                data-sending={sending ? "true" : "false"}
                                aria-label={`${example.title}静态样例`}
                            >
                                <div class="chat-composer-input">
                                    <button
                                        class="chat-composer-tool chat-attach"
                                        type="button"
                                        aria-label="添加图片"
                                        aria-busy="false"
                                        disabled
                                    >
                                        <span
                                            class="chat-attach-glyph"
                                            aria-hidden="true"
                                        >
                                            <span class="chat-attach-ready">
                                                <Icon name="attach" />
                                            </span>
                                            <span class="chat-attach-spinner">
                                                <Icon name="spinner" />
                                            </span>
                                        </span>
                                    </button>
                                    <label class="sr-only" for={id}>
                                        示例消息
                                    </label>
                                    <textarea
                                        id={id}
                                        class="chat-draft"
                                        rows={1}
                                        placeholder="发送消息给 Heimdall…"
                                        aria-describedby={hintId}
                                        style={example.state === "long"
                                            ? { height: "116px" }
                                            : undefined}
                                        disabled
                                    >
                                        {example.draft}
                                    </textarea>
                                    <div class="chat-composer-action-slot">
                                        <button
                                            class="chat-send chat-send-action"
                                            type="submit"
                                            aria-label="发送消息"
                                            aria-hidden={sending
                                                ? "true"
                                                : undefined}
                                            data-preview-ready={!!example.draft}
                                            disabled
                                        >
                                            <Icon name="send" />
                                        </button>
                                        <button
                                            class="chat-send chat-stop-action"
                                            type="button"
                                            aria-label="停止生成"
                                            aria-hidden={sending
                                                ? undefined
                                                : "true"}
                                            data-preview-ready={sending}
                                            tabindex={-1}
                                            disabled
                                        >
                                            <Icon name="stop" />
                                        </button>
                                    </div>
                                </div>
                            </form>
                            <div class="chat-composer-meta">
                                <p id={hintId} class="chat-composer-hint">
                                    {sending
                                        ? "正在生成回复…"
                                        : "Enter 发送，Shift + Enter 换行"}
                                </p>
                            </div>
                        </div>
                    </article>
                );
            })}
        </section>
    );
}

import type { Child } from "hono/jsx";
import { Icon } from "../src/web/shared/icons.tsx";
import { SchemaFields } from "../src/web/components/schema-fields.tsx";
import { sourceConfigSchema } from "../src/web/shared/source-schemas.ts";

export function PreviewFlowBack({ href }: { href: string }) {
    return (
        <a class="icon-button" href={href} aria-label="上一步" title="上一步">
            <Icon name="arrow-left" />
            <span class="sr-only">上一步</span>
        </a>
    );
}

function PreviewFlowClose() {
    return (
        <button
            type="button"
            class="icon-button"
            aria-label="关闭"
            title="关闭"
            disabled
        >
            <Icon name="close" />
            <span class="sr-only">关闭</span>
        </button>
    );
}

function FlowProgress({ active }: { active: number }) {
    return (
        <p class="source-flow-progress" aria-label="添加渠道步骤">
            <span>{active + 1} / 3</span>
            <span>{["基本信息", "配置方式", "完成配置"][active]}</span>
        </p>
    );
}

/** Each article is a static snapshot of the same modal, never a destination page. */
export function SourceDialogFrame({
    id,
    active,
    caption,
    title,
    children,
}: {
    id: string;
    active: number;
    caption: string;
    title?: string;
    children: Child;
}) {
    return (
        <section id={id} class="preview-modal-stage" aria-label={caption}>
            <p class="preview-stage-label">{caption}</p>
            <article
                class={`source-dialog source-create-dialog preview-dialog${
                    active === 2 ? " source-dialog-configure" : ""
                }`}
                aria-labelledby={`${id}-title`}
            >
                <div class="panel-heading source-dialog-header">
                    <div>
                        <h2 id={`${id}-title`}>
                            {title ??
                                (active === 0 ? "添加渠道" : "选择配置方式")}
                        </h2>
                        <FlowProgress active={active} />
                    </div>
                    <PreviewFlowClose />
                </div>
                {active !== 0 && (
                    <p class="source-flow-context">
                        <span>主力模型服务</span>
                        <span>优先级 10</span>
                    </p>
                )}
                <div
                    class={`source-flow-content source-flow-${
                        ["details", "choice", "configure"][active]
                    }`}
                >
                    {children}
                </div>
            </article>
        </section>
    );
}

/** Mirrors the plugin's form layout without importing its browser-only entry. */
function PresetIllustration() {
    return (
        <div class="preset-editor">
            <form class="newapi-setup source-preset-form">
                <div class="source-flow-body">
                    <div class="schema-form">
                        <div class="schema-field wide-field">
                            <label for="flow-newapi-url">
                                服务地址{" "}
                                <span class="field-required">必填</span>
                            </label>
                            <input
                                id="flow-newapi-url"
                                type="url"
                                value="https://gateway.example/v1"
                                disabled
                            />
                            <p class="field-help">
                                使用 NewAPI 提供的 API 地址，通常以 /v1 结尾。
                            </p>
                        </div>
                        <div class="schema-field wide-field">
                            <label for="flow-newapi-token">访问令牌</label>
                            <div class="secret-control">
                                <input
                                    id="flow-newapi-token"
                                    type="password"
                                    placeholder="输入 NewAPI 中创建的令牌"
                                    disabled
                                />
                                <button
                                    class="icon-button"
                                    type="button"
                                    aria-label="显示访问令牌"
                                    title="显示访问令牌"
                                    disabled
                                >
                                    <Icon name="eye" />
                                </button>
                            </div>
                            <p class="field-help">
                                如服务允许免认证可留空。令牌不会写入浏览器草稿。
                            </p>
                        </div>
                    </div>
                </div>
                <div class="config-actions source-flow-footer source-preset-actions">
                    <button type="button" class="secondary-button" disabled>
                        校验配置
                    </button>
                    <button type="submit" class="primary-button" disabled>
                        保存渠道
                    </button>
                </div>
            </form>
        </div>
    );
}

export function SourceConfigurationDialogs() {
    return (
        <>
            <SourceDialogFrame
                id="flow-preset"
                active={2}
                title="NewAPI"
                caption="03 A · 同一模态内的 NewAPI 预设 JSX · 静态布局示意"
            >
                <section class="source-preset-config">
                    <PresetIllustration />
                    <div class="config-actions source-flow-footer source-flow-back">
                        <PreviewFlowBack href="#flow-choice" />
                    </div>
                </section>
            </SourceDialogFrame>
            <SourceDialogFrame
                id="flow-custom"
                active={2}
                title="填写连接参数"
                caption="03 B · 同一模态内的自定义配置 · 宿主 schema 表单"
            >
                <form class="source-config-form">
                    <div class="source-flow-body">
                        <label class="source-config-source">
                            源类型
                            <select disabled>
                                <option value="heimdall.source.openai-compatible">
                                    OpenAI 兼容来源
                                </option>
                            </select>
                        </label>
                        <SchemaFields
                            schema={sourceConfigSchema(
                                "heimdall.source.openai-compatible",
                            )}
                            values={{
                                baseUrl: "https://gateway.example/v1",
                                modelMap: '{"atlas-chat":"upstream-chat"}',
                            }}
                            idPrefix="flow-custom"
                            disabled
                        />
                    </div>
                    <div class="config-actions source-flow-footer">
                        <PreviewFlowBack href="#flow-choice" />
                        <button type="submit" class="primary-button" disabled>
                            保存渠道
                        </button>
                    </div>
                </form>
            </SourceDialogFrame>
        </>
    );
}

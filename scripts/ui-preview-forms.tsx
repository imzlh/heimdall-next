import { SchemaFields } from "../src/web/components/schema-fields.tsx";
import { Icon } from "../src/web/shared/icons.tsx";
import { catalogueSchema } from "./ui-preview-data.ts";
import {
    PreviewFlowBack,
    SourceConfigurationDialogs,
    SourceDialogFrame,
} from "./ui-preview-source-dialog.tsx";

export function DesignFlow() {
    return (
        <section id="flow" class="preview-section" aria-labelledby="flow-title">
            <header class="page-heading">
                <div>
                    <p class="eyebrow">设计流程 · 示例数据</p>
                    <h2 id="flow-title">添加渠道</h2>
                    <p>
                        基本信息 → 预设或自定义 → 完成配置；全部在同一个模态内。
                    </p>
                </div>
            </header>
            <p class="notice">
                以下按顺序展示同一个模态的不同步骤。选择预设后，插件 JSX
                直接渲染在窗内；选择自定义后，窗内展示宿主表单。保存会保留名称和优先级，关闭模态并刷新渠道列表。预览链接仅定位步骤，不执行保存。
            </p>
            <SourceDialogFrame
                id="flow-details"
                active={0}
                caption="01 · 添加渠道模态 · 基本信息"
            >
                <form>
                    <div class="source-flow-body">
                        <label>
                            渠道名称
                            <input value="主力模型服务" disabled />
                        </label>
                        <label>
                            优先级
                            <input type="number" value={10} disabled />
                        </label>
                    </div>
                    <div class="config-actions source-flow-footer">
                        <button type="button" class="text-button" disabled>
                            取消
                        </button>
                        <a class="primary-button" href="#flow-choice">下一步</a>
                    </div>
                </form>
            </SourceDialogFrame>
            <SourceDialogFrame
                id="flow-choice"
                active={1}
                caption="02 · 同一模态内选择配置方式"
            >
                <div class="source-flow-body">
                    <div class="template-options" aria-label="配置方式">
                        <a
                            class="template-option template-option-link"
                            href="#flow-preset"
                        >
                            <span class="template-option-body">
                                <strong class="template-option-title">
                                    NewAPI
                                </strong>
                                <span class="template-option-description">
                                    OpenAI 兼容来源
                                </span>
                            </span>
                            <Icon
                                name="chevron-right"
                                class="template-option-arrow"
                            />
                        </a>
                        <a
                            class="template-option template-option-link"
                            href="#flow-chathub-awaiting"
                        >
                            <span class="template-option-body">
                                <strong class="template-option-title">
                                    Microsoft ChatHub
                                </strong>
                                <span class="template-option-description">
                                    Microsoft ChatHub
                                </span>
                            </span>
                            <Icon
                                name="chevron-right"
                                class="template-option-arrow"
                            />
                        </a>
                        <a
                            class="template-option template-option-link"
                            href="#flow-custom"
                        >
                            <span class="template-option-body">
                                <strong class="template-option-title">
                                    自定义配置
                                </strong>
                                <span class="template-option-description">
                                    手动填写连接参数
                                </span>
                            </span>
                            <Icon
                                name="chevron-right"
                                class="template-option-arrow"
                            />
                        </a>
                    </div>
                </div>
                <div class="config-actions source-flow-footer">
                    <PreviewFlowBack href="#flow-details" />
                </div>
            </SourceDialogFrame>
            <SourceConfigurationDialogs />
            <ChatHubAuthorizationDialogs />
            <section class="preview-modal-stage" aria-label="保存成功状态示例">
                <p class="preview-stage-label">
                    04 · 保存成功 · 模态关闭，渠道列表已刷新
                </p>
                <div class="source-created-toast preview-created-toast">
                    <span>已添加渠道「主力模型服务」</span>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="关闭通知"
                        title="关闭通知"
                        disabled
                    >
                        <Icon name="close" />
                    </button>
                </div>
            </section>
        </section>
    );
}

/** Static copies of the plugin's two authorization states; no credentials or links. */
function ChatHubAuthorizationDialogs() {
    return (
        <>
            {([false, true] as const).map((authorized) => {
                const id = `flow-chathub-${
                    authorized ? "authorized" : "awaiting"
                }`;
                return (
                    <SourceDialogFrame
                        id={id}
                        active={2}
                        title="Microsoft ChatHub"
                        caption={`03 ${
                            authorized ? "D" : "C"
                        } · 同一模态内的 ChatHub 预设 · ${
                            authorized ? "已授权" : "等待登录"
                        }静态示意`}
                    >
                        <div class="source-preset-config">
                            <div class="preset-editor">
                                <form class="preset-auth source-preset-form">
                                    <div class="source-flow-body">
                                        <div
                                            class={`preset-auth-panel${
                                                authorized
                                                    ? " is-authorized"
                                                    : ""
                                            }`}
                                        >
                                            {authorized
                                                ? (
                                                    <div class="preset-auth-account">
                                                        <span
                                                            class="preset-auth-check"
                                                            aria-hidden="true"
                                                        >
                                                            <Icon name="check" />
                                                        </span>
                                                        <div>
                                                            <strong>
                                                                team@example.com
                                                            </strong>
                                                            <p class="field-help">
                                                                已授权，可以保存渠道。
                                                            </p>
                                                        </div>
                                                        <button
                                                            class="icon-button"
                                                            type="button"
                                                            aria-label="更换账号"
                                                            title="更换账号"
                                                            disabled
                                                        >
                                                            <Icon name="account" />
                                                        </button>
                                                    </div>
                                                )
                                                : (
                                                    <>
                                                        <div class="preset-auth-heading">
                                                            <div>
                                                                <strong>
                                                                    Microsoft
                                                                    账号授权
                                                                </strong>
                                                                <p class="field-help">
                                                                    登录完成后，将回调网址粘贴回这里。
                                                                </p>
                                                            </div>
                                                            <span class="status-chip chip-muted">
                                                                等待登录
                                                            </span>
                                                        </div>
                                                        <div class="preset-auth-steps">
                                                            <div class="preset-auth-step">
                                                                <span
                                                                    class="preset-auth-step-number"
                                                                    aria-hidden="true"
                                                                >
                                                                    1
                                                                </span>
                                                                <div>
                                                                    <button
                                                                        class="secondary-button preset-auth-link"
                                                                        type="button"
                                                                        disabled
                                                                    >
                                                                        前往
                                                                        Microsoft
                                                                        登录
                                                                        {" "}
                                                                        <Icon
                                                                            name="external-link"
                                                                            size={16}
                                                                        />
                                                                    </button>
                                                                    <p class="field-help">
                                                                        在新窗口完成登录，本配置窗会保留。
                                                                    </p>
                                                                </div>
                                                            </div>
                                                            <div class="preset-auth-step">
                                                                <span
                                                                    class="preset-auth-step-number"
                                                                    aria-hidden="true"
                                                                >
                                                                    2
                                                                </span>
                                                                <div class="schema-field">
                                                                    <label
                                                                        for={`${id}-callback`}
                                                                    >
                                                                        粘贴登录回调网址
                                                                    </label>
                                                                    <input
                                                                        id={`${id}-callback`}
                                                                        type="password"
                                                                        placeholder="粘贴登录后的完整回调网址"
                                                                        disabled
                                                                    />
                                                                    <p class="field-help">
                                                                        复制地址栏中包含
                                                                        nativeclient?code=…
                                                                        的完整网址。
                                                                    </p>
                                                                    <div class="preset-auth-inline-actions">
                                                                        <button
                                                                            class="primary-button"
                                                                            type="button"
                                                                            disabled
                                                                        >
                                                                            完成授权
                                                                        </button>
                                                                        <button
                                                                            class="icon-button"
                                                                            type="button"
                                                                            aria-label="重新准备授权"
                                                                            title="重新准备授权"
                                                                            disabled
                                                                        >
                                                                            <Icon name="refresh" />
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </>
                                                )}
                                        </div>
                                        <details class="preset-auth-options">
                                            <summary>
                                                模型选项{" "}
                                                <span class="field-help">
                                                    可选
                                                </span>
                                            </summary>
                                            <div class="schema-field">
                                                <label for={`${id}-models`}>
                                                    发布的模型
                                                </label>
                                                <input
                                                    id={`${id}-models`}
                                                    placeholder="留空使用渠道默认模型"
                                                    disabled
                                                />
                                                <p class="field-help">
                                                    需要覆盖默认值时填写模型名称，多个模型用逗号分隔。
                                                </p>
                                            </div>
                                        </details>
                                    </div>
                                    <div class="config-actions source-flow-footer source-preset-actions">
                                        <button
                                            class="secondary-button"
                                            type="button"
                                            disabled
                                        >
                                            校验配置
                                        </button>
                                        <button
                                            class="primary-button"
                                            type="submit"
                                            disabled
                                        >
                                            保存渠道
                                        </button>
                                    </div>
                                </form>
                            </div>
                            <div class="config-actions source-flow-footer source-flow-back">
                                <PreviewFlowBack href="#flow-choice" />
                            </div>
                        </div>
                    </SourceDialogFrame>
                );
            })}
        </>
    );
}

export function ControlCatalogue() {
    return (
        <section
            id="controls"
            class="preview-section"
            aria-labelledby="controls-title"
        >
            <header class="page-heading">
                <div>
                    <p class="eyebrow">宿主统一控件 · 示例状态</p>
                    <h2 id="controls-title">Schema 表单目录</h2>
                    <p class="preview-schema-key">
                        string · secret · number · bool · enum · group ·
                        authorization
                    </p>
                </div>
            </header>
            <div class="panel">
                <SchemaFields
                    schema={catalogueSchema}
                    idPrefix="catalogue"
                    existingSecrets={["apiKey"]}
                    errors={{ displayName: "请填写此项（校验状态示例）" }}
                    authorization={{
                        idle: { state: "idle", message: "尚未授权 · 示例状态" },
                        pending: {
                            state: "pending",
                            message: "等待授权结果 · 示例状态",
                        },
                        success: {
                            state: "success",
                            message: "已完成授权 · 示例状态",
                        },
                        error: {
                            state: "error",
                            message: "授权失败，可重试 · 示例状态",
                        },
                    }}
                    disabled
                />
                <p class="notice preset-preview">
                    此处仅展示控件及状态。预览不发起授权、请求、探测或配置写入。
                </p>
            </div>
        </section>
    );
}

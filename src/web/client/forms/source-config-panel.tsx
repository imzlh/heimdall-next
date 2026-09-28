/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef } from "hono/jsx/dom";
import { SchemaForm } from "./schema-form.tsx";
import { Dropdown } from "./dropdown.tsx";
import { formControls } from "@heimdall/admin-contracts/forms.ts";
import { Icon } from "../../shared/icons.tsx";
import {
    type SourceConfigPanelProps,
    useSourceConfig,
} from "./source-config-state.ts";

/** Channel configuration opens as a modal, never as an inline page section. */
export function SourceConfigPanel(props: SourceConfigPanelProps) {
    const state = useSourceConfig(props);
    const dialog = useRef<HTMLDialogElement | null>(null);
    useEffect(() => {
        const element = dialog.current;
        if (element && !element.open) element.showModal();
        return () => {
            if (element?.open) element.close();
        };
    }, []);
    const disabled = state.busy || !state.loaded || state.conflict;
    const close = () => {
        if (!state.busy) props.onClose();
    };
    return (
        <dialog
            ref={dialog}
            class="source-dialog source-config-dialog"
            aria-labelledby="source-config-title"
            aria-busy={state.busy ? "true" : "false"}
            onCancel={(event: Event) => {
                event.preventDefault();
                close();
            }}
        >
            <div class="panel-heading">
                <div>
                    <p class="eyebrow">渠道配置</p>
                    <h2 id="source-config-title">
                        {props.title || props.sourceId}
                    </h2>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="关闭"
                    title="关闭渠道配置"
                    disabled={state.busy}
                    onClick={close}
                >
                    <Icon name="close" />
                </button>
            </div>
            <p class="source-management-id">
                <code>{props.sourceId}</code>
            </p>
            {state.loading && <p role="status">正在读取渠道配置…</p>}
            {!state.hasSchema
                ? <p class="notice">此渠道未提供受支持的配置表单。</p>
                : (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void state.run("save");
                        }}
                    >
                        <div class="config-mode">
                            <span class="config-mode-label">配置方式</span>
                            <Dropdown
                                value={state.mode}
                                disabled={disabled}
                                options={[
                                    { value: "", label: "自定义配置" },
                                    ...state.availablePresets.map((preset) => ({
                                        value: preset.id,
                                        label: preset.name || preset.id,
                                    })),
                                ]}
                                onChange={(mode) => state.selectMode(mode)}
                            />
                        </div>
                        {state.mode && (
                            <p class="field-help preset-help">
                                填写预设需要的信息。切换到自定义配置可查看底层参数。
                            </p>
                        )}
                        <SchemaForm
                            schema={state.displaySchema}
                            values={state.values}
                            errors={state.errors}
                            existingSecrets={state.existingSecrets}
                            disabled={disabled}
                            onValuesChange={state.edit}
                        />
                        {state.previewed && (
                            <div class="notice preset-preview" role="status">
                                <strong>预设预览</strong>
                                <p>更新渠道：{props.sourceId}</p>
                                {formControls(state.displaySchema).filter((
                                    field,
                                ) => field.type !== "authorization").map((
                                    field,
                                ) => (
                                    <p key={field.name}>
                                        {field.label}：{field.type === "secret"
                                            ? String(
                                                    state.values[field.name] ??
                                                        "",
                                                ).trim()
                                                ? "将更新"
                                                : state.existingSecrets
                                                        .includes(field.name)
                                                ? "保留已有密钥"
                                                : "未提供"
                                            : String(
                                                state.values[field.name] ??
                                                    "未提供",
                                            )}
                                    </p>
                                ))}
                            </div>
                        )}
                        <div class="config-actions">
                            <button
                                type="submit"
                                class="primary-button"
                                disabled={disabled}
                            >
                                {state.action === "save"
                                    ? "保存中…"
                                    : state.mode
                                    ? "应用预设"
                                    : "保存并启用"}
                            </button>
                            <button
                                type="button"
                                class="text-button"
                                disabled={disabled}
                                onClick={() =>
                                    void state.run(
                                        state.mode ? "preview" : "validate",
                                    )}
                            >
                                {state.mode ? "预览预设" : "校验配置"}
                            </button>
                            <button
                                type="button"
                                class="icon-button"
                                aria-label="探测已保存配置"
                                title="探测已保存配置"
                                disabled={disabled}
                                onClick={() => void state.run("probe")}
                            >
                                <Icon name="activity" />
                            </button>
                            <button
                                type="button"
                                class="icon-button"
                                aria-label="重新加载"
                                title="重新加载配置"
                                disabled={state.busy}
                                onClick={state.reload}
                            >
                                <Icon name="refresh" />
                            </button>
                        </div>
                    </form>
                )}
            {state.error && <p class="form-error" role="alert">{state.error}
            </p>}
            {state.message && (
                <p class="form-success" role="status">{state.message}</p>
            )}
        </dialog>
    );
}

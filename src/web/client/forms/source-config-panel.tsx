/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { SchemaForm } from "./schema-form.tsx";
import { formControls } from "@heimdall/admin-contracts/forms.ts";
import { controlValue } from "../dom.ts";
import { Icon } from "../../shared/icons.tsx";
import {
    type SourceConfigPanelProps,
    useSourceConfig,
} from "./source-config-state.ts";

export function SourceConfigPanel(props: SourceConfigPanelProps) {
    const state = useSourceConfig(props);
    const disabled = state.busy || !state.loaded || state.conflict;
    return (
        <section
            class="panel config-panel"
            aria-labelledby="source-config-title"
            aria-busy={state.busy ? "true" : "false"}
        >
            <div class="panel-heading">
                <div>
                    <h2 id="source-config-title">配置渠道</h2>
                    <p>{props.sourceId}</p>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="关闭"
                    title="关闭渠道配置"
                    disabled={state.busy}
                    onClick={props.onClose}
                >
                    <Icon name="close" />
                </button>
            </div>
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
                        <label class="config-mode">
                            配置方式<select
                                value={state.mode}
                                disabled={disabled}
                                onChange={(event) =>
                                    state.selectMode(controlValue(event))}
                            >
                                <option value="">自定义配置</option>
                                {state.availablePresets.map((preset) => (
                                    <option value={preset.id} key={preset.id}>
                                        {preset.name || preset.id}
                                    </option>
                                ))}
                            </select>
                        </label>
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
        </section>
    );
}

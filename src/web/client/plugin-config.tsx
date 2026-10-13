/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { ToolConfigDto } from "@heimdall/admin-contracts";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import { parseSourceConfigSchema } from "@heimdall/admin-contracts/form-schema.ts";
import {
    formControls,
    type FormErrors,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
    validateForm,
} from "@heimdall/admin-contracts/forms.ts";
import { AdminApiError, describeError } from "./api/transport.ts";
import { loadToolConfig, saveToolConfig } from "./api/tool-config.ts";
import { SchemaForm } from "./forms/schema-form.tsx";
import { PluginDialog } from "./plugin-dialog.tsx";

interface LoadedConfig {
    dto: ToolConfigDto;
    schema: SourceConfigSchema;
    existingSecrets: string[];
}

/** All controls come from the plugin's validated host form schema. */
export function PluginConfigDialog({ plugin, onClose, onSaved }: {
    plugin: ListedPlugin;
    onClose: () => void;
    onSaved: () => Promise<void>;
}) {
    const [loaded, setLoaded] = useState<LoadedConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [values, setValues] = useState<FormValues>({});
    const [errors, setErrors] = useState<FormErrors>({});
    const [error, setError] = useState("");
    const [conflict, setConflict] = useState(false);
    const busy = useRef(false);
    const mounted = useRef(true);
    const request = useRef<AbortController | null>(null);

    async function reload() {
        if (busy.current) return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true);
        setLoaded(null);
        setError("");
        setErrors({});
        try {
            const dto = await loadToolConfig(plugin.id, controller.signal);
            if (!mounted.current || controller.signal.aborted) return;
            const schema = parseSourceConfigSchema(dto.configSchema);
            const existingSecrets = formControls(schema).filter((field) =>
                field.type === "secret" &&
                typeof dto.config[field.name] === "string" &&
                Boolean(dto.config[field.name])
            ).map((field) => field.name);
            setLoaded({ dto, schema, existingSecrets });
            setValues(initialFormValues(schema, dto.config));
            setConflict(false);
        } catch (error) {
            if (mounted.current && !controller.signal.aborted) {
                setError(`加载插件配置失败：${describeError(error)}`);
            }
        } finally {
            if (mounted.current && !controller.signal.aborted) {
                setLoading(false);
            }
        }
    }

    useEffect(() => {
        mounted.current = true;
        void reload();
        return () => {
            mounted.current = false;
            request.current?.abort();
        };
    }, [plugin.id]);

    function close() {
        if (busy.current) return;
        request.current?.abort();
        onClose();
    }

    async function save(event: Event) {
        event.preventDefault();
        if (busy.current || loading || conflict || !loaded) return;
        const checked = validateForm(loaded.schema, values, {
            existingSecrets: loaded.existingSecrets,
        });
        setErrors(checked.errors);
        if (!checked.valid) return;
        busy.current = true;
        setSaving(true);
        setError("");
        try {
            // Send declared fields only; the host preserves secrets from its stored config.
            await saveToolConfig(
                plugin.id,
                checked.values,
                loaded.dto.revision,
            );
            if (mounted.current) await onSaved();
        } catch (error) {
            if (!mounted.current) return;
            if (error instanceof AdminApiError && error.status === 409) {
                setConflict(true);
                setError(
                    "配置已被其他操作更新，请重新加载配置后再保存。当前编辑内容已保留。",
                );
            } else setError(`保存配置失败：${describeError(error)}`);
        } finally {
            busy.current = false;
            if (mounted.current) setSaving(false);
        }
    }

    return (
        <PluginDialog
            title={`配置 ${plugin.name || plugin.id}`}
            busy={saving}
            onClose={close}
        >
            <form onSubmit={(event: Event) => void save(event)}>
                {loading && <p role="status">正在加载插件配置…</p>}
                {loaded && (
                    <SchemaForm
                        schema={loaded.schema}
                        values={values}
                        errors={errors}
                        existingSecrets={loaded.existingSecrets}
                        disabled={saving || loading}
                        idPrefix={`plugin-config-${
                            encodeURIComponent(plugin.id)
                        }`}
                        onValuesChange={(next) => {
                            setValues(next);
                            setErrors({});
                        }}
                    />
                )}
                {error && <p class="form-error" role="alert">{error}</p>}
                {!loading && (conflict || !loaded) && (
                    <button
                        type="button"
                        class="text-button"
                        disabled={saving}
                        onClick={() => void reload()}
                    >
                        重新加载配置
                    </button>
                )}
                <footer class="plugin-dialog-actions">
                    <button
                        type="button"
                        class="text-button"
                        disabled={saving}
                        onClick={close}
                    >
                        取消
                    </button>
                    <button
                        type="submit"
                        class="primary-button"
                        disabled={saving || loading || conflict || !loaded}
                    >
                        {saving ? "保存中…" : "保存配置"}
                    </button>
                </footer>
            </form>
        </PluginDialog>
    );
}

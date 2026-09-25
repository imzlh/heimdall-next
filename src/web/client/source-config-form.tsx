/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import {
    type FormErrors,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
    validateForm,
} from "@heimdall/admin-contracts/forms.ts";
import type { PresetJsonObject } from "@heimdall/admin-contracts/preset-ui.ts";
import { describeError } from "./api/admin.ts";
import { SchemaForm } from "./forms/schema-form.tsx";
import { controlValue } from "./dom.ts";
import { Icon } from "../shared/icons.tsx";
import type { SourceSetupDraft } from "./source-setup-draft.ts";

export interface SourceSetupSource {
    /** The plugin identity, never an existing configured channel id. */
    readonly id: string;
    readonly name: string;
    readonly schema?: SourceConfigSchema;
}

export interface SourceSetupSaveInput {
    readonly draft: SourceSetupDraft;
    readonly sourcePluginId: string;
    readonly config: FormValues | PresetJsonObject;
}

interface CustomSourceConfigProps {
    readonly draft: SourceSetupDraft;
    readonly sources: readonly SourceSetupSource[];
    readonly sourcePluginId: string;
    readonly disabled: boolean;
    readonly hideSourceSelection?: boolean;
    readonly onSelectSource: (id: string) => void;
    readonly onSave: (input: SourceSetupSaveInput) => Promise<void>;
    readonly onBack?: () => void;
}

/** Host-rendered fields inside the creation dialog. Unmounting drops secrets. */
export function CustomSourceConfig(
    {
        draft,
        sources,
        sourcePluginId,
        disabled,
        hideSourceSelection,
        onSelectSource,
        onSave,
        onBack,
    }: CustomSourceConfigProps,
) {
    const configurable = sources.filter((source) => source.schema);
    const [drafts, setDrafts] = useState<Readonly<Record<string, FormValues>>>(
        {},
    );
    const [errors, setErrors] = useState<FormErrors>({});
    const [error, setError] = useState("");
    const busy = useRef(false);
    const mounted = useRef(true);
    const form = useRef<HTMLFormElement | null>(null);
    const schema = sources.find((source) => source.id === sourcePluginId)
        ?.schema;
    const values = drafts[sourcePluginId] ??
        (schema ? initialFormValues(schema) : {});

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        if (Object.keys(errors).length) {
            form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
        }
    }, [errors]);

    async function submit(event: Event) {
        event.preventDefault();
        if (busy.current || disabled || !schema || !sourcePluginId) return;
        const checked = validateForm(schema, values);
        setErrors(checked.errors);
        setError("");
        if (!checked.valid) {
            setError("请检查标记的字段后再保存。");
            return;
        }
        busy.current = true;
        try {
            await onSave({ draft, sourcePluginId, config: checked.values });
            if (mounted.current) setDrafts({});
        } catch (cause) {
            if (mounted.current) setError(describeError(cause));
        } finally {
            busy.current = false;
        }
    }

    return (
        <form
            class="source-config-form"
            ref={form}
            noValidate
            onSubmit={submit}
        >
            <div class="source-flow-body">
                {!hideSourceSelection && (
                    <label class="source-config-source">
                        源类型
                        <select
                            value={sourcePluginId}
                            required
                            disabled={disabled}
                            onChange={(event) => {
                                onSelectSource(controlValue(event));
                                setErrors({});
                                setError("");
                            }}
                        >
                            <option value="">请选择源类型</option>
                            {configurable.map((source) => (
                                <option key={source.id} value={source.id}>
                                    {source.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )}
                {schema
                    ? (
                        <SchemaForm
                            key={sourcePluginId}
                            schema={schema}
                            values={values}
                            errors={errors}
                            disabled={disabled}
                            idPrefix="source-create"
                            onValuesChange={(next) => {
                                setDrafts((current) => ({
                                    ...current,
                                    [sourcePluginId]: next,
                                }));
                                setErrors({});
                                setError("");
                            }}
                        />
                    )
                    : (
                        <p class="empty-state">
                            {configurable.length
                                ? "选择源类型后，在这里填写连接参数。"
                                : "当前没有提供配置表单的源插件。"}
                        </p>
                    )}
                {error && <p class="form-error" role="alert">{error}</p>}
            </div>
            <div class="config-actions source-flow-footer">
                {onBack && (
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="上一步"
                        title="上一步"
                        disabled={disabled}
                        onClick={onBack}
                    >
                        <Icon name="arrow-left" />
                        <span class="sr-only">上一步</span>
                    </button>
                )}
                <button
                    type="submit"
                    class="primary-button"
                    disabled={disabled || !schema}
                >
                    {disabled ? "保存中…" : "保存渠道"}
                </button>
            </div>
        </form>
    );
}

/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import {
    formControls,
    type FormErrors,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
    validateForm,
} from "@heimdall/admin-contracts/forms.ts";
import type { PresetJsonObject } from "@heimdall/admin-contracts/preset-ui.ts";
import { describeError } from "./api/admin.ts";
import { SchemaForm } from "./forms/schema-form.tsx";
import { Dropdown } from "./forms/dropdown.tsx";
import { Icon } from "../shared/icons.tsx";
import type { SourceSetupDraft } from "./source-setup-draft.ts";
import type { SourceDraftProbeResult } from "@heimdall/admin-contracts/source-probe.ts";
import {
    addDiscoveredModel,
    readModelMap,
    SourceModels,
} from "./forms/source-models.tsx";

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

export type SourceSetupProbe = (
    input: SourceSetupSaveInput,
    signal: AbortSignal,
) => Promise<SourceDraftProbeResult>;

interface CustomSourceConfigProps {
    readonly draft: SourceSetupDraft;
    readonly sources: readonly SourceSetupSource[];
    readonly sourcePluginId: string;
    readonly disabled: boolean;
    readonly hideSourceSelection?: boolean;
    readonly onSelectSource: (id: string) => void;
    readonly onSave: (input: SourceSetupSaveInput) => Promise<void>;
    readonly onProbe?: SourceSetupProbe;
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
        onProbe,
        onBack,
    }: CustomSourceConfigProps,
) {
    const configurable = sources.filter((source) => source.schema);
    const [drafts, setDrafts] = useState<Readonly<Record<string, FormValues>>>(
        {},
    );
    const [errors, setErrors] = useState<FormErrors>({});
    const [error, setError] = useState("");
    const [probing, setProbing] = useState(false);
    const [probe, setProbe] = useState<SourceDraftProbeResult | null>(null);
    const probeRequest = useRef<AbortController | null>(null);
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
            probeRequest.current?.abort();
        };
    }, []);
    useEffect(() => {
        if (Object.keys(errors).length) {
            form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
        }
    }, [errors]);

    function invalidateProbe() {
        probeRequest.current?.abort();
        probeRequest.current = null;
        setProbing(false);
        setProbe(null);
    }

    async function testConnection() {
        if (
            !schema || !onProbe || busy.current || disabled ||
            probeRequest.current
        ) return;
        const checked = validateForm(schema, values);
        setErrors(checked.errors);
        setError("");
        if (!checked.valid) return;
        const controller = new AbortController();
        probeRequest.current = controller;
        setProbing(true);
        setProbe(null);
        try {
            const result = await onProbe({
                draft,
                sourcePluginId,
                config: checked.values,
            }, controller.signal);
            if (mounted.current && probeRequest.current === controller) {
                setProbe(result);
            }
        } catch (cause) {
            if (
                mounted.current && !controller.signal.aborted &&
                probeRequest.current === controller
            ) setError(describeError(cause));
        } finally {
            if (mounted.current && probeRequest.current === controller) {
                probeRequest.current = null;
                setProbing(false);
            }
        }
    }

    const modelField = schema &&
        formControls(schema).some((field) =>
            field.name === "modelMap" && field.type === "string" &&
            field.format === "string-map"
        );
    let selectedModels: string[] = [];
    try {
        selectedModels = Object.keys(readModelMap(values.modelMap));
    } catch { /* Keep the operator's invalid input for correction. */ }

    async function submit(event: Event) {
        event.preventDefault();
        if (busy.current || disabled || probing || !schema || !sourcePluginId) {
            return;
        }
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
                    <div class="source-config-source">
                        <span class="field-label">源类型</span>
                        <Dropdown
                            value={sourcePluginId}
                            dataName="source-type"
                            disabled={disabled}
                            placeholder="请选择源类型"
                            ariaLabel="源类型"
                            options={[
                                { value: "", label: "请选择源类型" },
                                ...configurable.map((source) => ({
                                    value: source.id,
                                    label: source.name,
                                })),
                            ]}
                            onChange={(next) => {
                                invalidateProbe();
                                onSelectSource(next);
                                setErrors({});
                                setError("");
                            }}
                        />
                    </div>
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
                                invalidateProbe();
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
                {onProbe && schema && (
                    <div class="source-probe-actions">
                        <button
                            type="button"
                            class="secondary-button"
                            disabled={disabled || probing}
                            onClick={() => void testConnection()}
                        >
                            <Icon name={probing ? "refresh" : "activity"} />
                            {probing
                                ? "测试连接并获取模型…"
                                : probe?.ok === false || error
                                ? "重新测试连接"
                                : "测试连接并获取模型"}
                        </button>
                        {probing && (
                            <p class="field-help" role="status">
                                正在使用当前输入测试连接，最长等待 10 秒。
                            </p>
                        )}
                    </div>
                )}
                {probe && (
                    <SourceModels
                        result={probe}
                        selected={selectedModels}
                        disabled={disabled}
                        onSelect={modelField
                            ? (model) => {
                                try {
                                    const modelMap = addDiscoveredModel(
                                        values.modelMap,
                                        model,
                                    );
                                    setDrafts((current) => ({
                                        ...current,
                                        [sourcePluginId]: {
                                            ...values,
                                            modelMap,
                                        },
                                    }));
                                    setError("");
                                } catch (cause) {
                                    setError(describeError(cause));
                                }
                            }
                            : undefined}
                    />
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
                    disabled={disabled || probing || !schema}
                >
                    {disabled ? "保存中…" : "保存渠道"}
                </button>
            </div>
        </form>
    );
}

/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import {
    type FormErrors,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
    validateForm,
} from "@heimdall/admin-contracts/forms.ts";
import type { PresetJsonObject } from "@heimdall/admin-contracts/preset-ui.ts";
import {
    parseSourceModelMap,
    type SourceModelMap,
} from "@heimdall/admin-contracts/source-model-map.ts";
import { describeError } from "./api/admin.ts";
import { SchemaForm } from "./forms/schema-form.tsx";
import { Dropdown } from "./forms/dropdown.tsx";
import { Icon } from "../shared/icons.tsx";
import type { SourceSetupDraft } from "./source-setup-draft.ts";
import type { SourceDraftProbeResult } from "@heimdall/admin-contracts/source-probe.ts";
import { SourceModels } from "./forms/source-models.tsx";

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
    readonly onModelMapChange?: (modelMap: SourceModelMap) => void;
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
        onModelMapChange,
        onBack,
    }: CustomSourceConfigProps,
) {
    const configurable = sources.filter((source) => source.schema);
    const [drafts, setDrafts] = useState<Readonly<Record<string, FormValues>>>(
        {},
    );
    const [errors, setErrors] = useState<FormErrors>({});
    const [error, setError] = useState("");
    const [probeError, setProbeError] = useState("");
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
        setProbeError("");
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
        setProbeError("");
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
            ) setProbeError(describeError(cause));
        } finally {
            if (mounted.current && probeRequest.current === controller) {
                probeRequest.current = null;
                setProbing(false);
            }
        }
    }

    const selectedModels = [
        ...Object.keys(draft.modelMap ?? {}),
        ...Object.values(draft.modelMap ?? {}),
    ];
    const probeFailed = probe?.ok === false || !!probeError;

    async function submit(event: Event) {
        event.preventDefault();
        if (
            busy.current || disabled || probeRequest.current || probing ||
            !schema || !sourcePluginId
        ) {
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
                                : probeFailed
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
                        onSelect={onModelMapChange
                            ? (model) => {
                                try {
                                    const modelMap = { ...draft.modelMap };
                                    if (
                                        !Object.hasOwn(modelMap, model) &&
                                        !Object.values(modelMap).includes(model)
                                    ) modelMap[model] = model;
                                    onModelMapChange(
                                        parseSourceModelMap(modelMap),
                                    );
                                    setError("");
                                } catch (cause) {
                                    setError(describeError(cause));
                                }
                            }
                            : undefined}
                    />
                )}
                {probeError && (
                    <p class="form-error" role="alert">{probeError}</p>
                )}
                {onProbe && schema && !probing && !probe?.ok && (
                    <p class="field-help" role="status">
                        {probeFailed
                            ? "连接测试未通过，可重试或跳过测试并保存。"
                            : "尚未测试连接。可先测试，也可直接保存。"}
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
                    disabled={disabled || probing || !schema}
                >
                    {disabled
                        ? "保存中…"
                        : probeFailed
                        ? "跳过测试并保存"
                        : "保存渠道"}
                </button>
            </div>
        </form>
    );
}

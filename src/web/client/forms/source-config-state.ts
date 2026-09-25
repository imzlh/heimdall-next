import { useEffect, useRef, useState } from "hono/jsx/dom";
import {
    formControls,
    type FormErrors,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
} from "@heimdall/admin-contracts/forms.ts";
import {
    AdminApiError,
    applyPreset,
    describeError,
    type ListedPreset,
    loadSourceConfig,
    previewPreset,
    probeSource,
    saveSourceConfig,
    type SourceConfigEnvelope,
    validateSourceConfig,
} from "../api/admin.ts";
import {
    presetConfigSchema,
    sourceConfigSchema,
    sourcePluginIdFor,
} from "../../shared/source-schemas.ts";
import { prepareSourceInput, sourceFormValues } from "./source-config-model.ts";

export interface SourceConfigPanelProps {
    sourceId: string;
    sourcePluginId?: string;
    schema?: SourceConfigSchema;
    presetSchemas?: Readonly<Record<string, SourceConfigSchema>>;
    presets: ListedPreset[];
    presetId?: string;
    onClose: () => void;
    onSaved: () => Promise<void>;
}

export function useSourceConfig(
    {
        sourceId,
        sourcePluginId,
        schema: declaredSchema,
        presetSchemas = {},
        presets,
        presetId = "",
        onSaved,
    }: SourceConfigPanelProps,
) {
    const pluginId = sourcePluginId ?? sourcePluginIdFor(sourceId);
    const schema = declaredSchema ?? sourceConfigSchema(pluginId ?? sourceId);
    const hasSchema = Boolean(declaredSchema) || schema.fields.length > 0;
    const presetSchemaFor = (id: string) =>
        presetSchemas[id] ?? presetConfigSchema(id);
    const availablePresets = presets.filter((preset) =>
        presetSchemaFor(preset.id) &&
        preset.sourcePluginId === pluginId
    );
    const [mode, setMode] = useState(
        availablePresets.some((preset) => preset.id === presetId)
            ? presetId
            : "",
    );
    const [values, setValues] = useState<FormValues>(sourceFormValues(schema));
    const [errors, setErrors] = useState<FormErrors>({});
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");
    const [loading, setLoading] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [action, setAction] = useState("");
    const [etag, setEtag] = useState("");
    const [existingSecrets, setExistingSecrets] = useState<readonly string[]>(
        [],
    );
    const [conflict, setConflict] = useState(false);
    const [revision, setRevision] = useState(0);
    const [previewed, setPreviewed] = useState(false);
    const busyRef = useRef(false);
    const mounted = useRef(true);
    const busy = loading || Boolean(action);
    const displaySchema = mode ? presetSchemaFor(mode) ?? schema : schema;

    function applyLoaded(result: SourceConfigEnvelope) {
        setValues({
            ...initialFormValues(displaySchema),
            ...sourceFormValues(schema, result.source?.config),
        });
        setExistingSecrets(
            formControls(schema).filter((field) =>
                field.type === "secret" &&
                result.source?.config?.[`${field.name}Configured`] === true
            ).map((field) => field.name),
        );
        setEtag(result.etag || result.source?.versionstamp || "");
        setLoaded(true);
        setConflict(false);
        setPreviewed(false);
    }

    useEffect(() => {
        let active = true;
        mounted.current = true;
        setLoading(true);
        setLoaded(false);
        setError("");
        setMessage("");
        loadSourceConfig(sourceId).then((result) => {
            if (active) applyLoaded(result);
        }).catch((cause) => {
            if (active) setError(describeError(cause));
        }).finally(() => {
            if (active) setLoading(false);
        });
        return () => {
            active = false;
            mounted.current = false;
        };
    }, [sourceId, sourcePluginId, declaredSchema, revision]);

    function edit(next: FormValues) {
        setValues({ ...values, ...next });
        setErrors({});
        setMessage("");
        setPreviewed(false);
    }

    function selectMode(next: string) {
        setValues({
            ...initialFormValues(
                next ? presetSchemaFor(next) ?? schema : schema,
            ),
            ...values,
        });
        setMode(next);
        setErrors({});
        setError("");
        setMessage("");
        setPreviewed(false);
    }

    async function run(kind: "validate" | "preview" | "save" | "probe") {
        if (
            busyRef.current || busy || !loaded || conflict ||
            !hasSchema
        ) return;
        busyRef.current = true;
        setAction(kind);
        setError("");
        setMessage("");
        try {
            if (kind === "probe") {
                const result = await probeSource(sourceId);
                if (!mounted.current) return;
                await onSaved();
                if (!mounted.current) return;
                if (!result.probe.ok) {
                    throw new Error(result.probe.message || "上游探测失败");
                }
                setMessage(result.probe.message || "上游连接正常");
                return;
            }
            const checked = prepareSourceInput(
                mode === "heimdall.preset.newapi" ? schema : displaySchema,
                values,
                sourceId,
                existingSecrets,
                mode,
            );
            setErrors(checked.errors);
            if (!checked.config) {
                setError(Object.values(checked.errors).join("；"));
                return;
            }
            if (mode) await previewPreset(mode, checked.config);
            else await validateSourceConfig(sourceId, checked.config);
            if (!mounted.current) return;
            if (kind !== "save") {
                setPreviewed(Boolean(mode));
                setMessage(
                    mode
                        ? "预设校验通过，应用后将更新当前渠道。"
                        : "配置校验通过",
                );
                return;
            }
            const result = mode
                ? await applyPreset(mode, checked.config, etag)
                : await saveSourceConfig(sourceId, checked.config, etag);
            if (!mounted.current) return;
            applyLoaded(result);
            setMessage(
                mode
                    ? "预设已应用，渠道配置已更新"
                    : "配置已保存，渠道已重新加载",
            );
            await onSaved();
        } catch (cause) {
            if (!mounted.current) return;
            if (
                cause instanceof AdminApiError &&
                [409, 412, 428].includes(cause.status)
            ) {
                setConflict(true);
                setError(
                    "渠道配置已发生变化，请重新加载最新配置后再编辑保存。",
                );
            } else setError(describeError(cause));
        } finally {
            busyRef.current = false;
            if (mounted.current) setAction("");
        }
    }

    return {
        schema,
        hasSchema,
        displaySchema,
        availablePresets,
        mode,
        selectMode,
        values,
        edit,
        errors,
        error,
        message,
        loading,
        loaded,
        busy,
        action,
        etag,
        existingSecrets,
        conflict,
        previewed,
        run,
        reload: () => setRevision((value) => value + 1),
    };
}

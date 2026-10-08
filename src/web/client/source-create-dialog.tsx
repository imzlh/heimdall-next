/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import type { DashboardData } from "@heimdall/admin-contracts/console.ts";
import type { ProxyPoolView } from "@heimdall/admin-contracts/proxies.ts";
import type { UiPolicy } from "@heimdall/admin-contracts/ui.ts";
import { safeUiAssetPath } from "@heimdall/admin-contracts/ui.ts";
import { AddSourceFlow } from "./add-source.tsx";
import { createSource, previewPreset, probeSourceDraft } from "./api/admin.ts";
import { PresetEditor } from "./forms/preset-editor.tsx";
import {
    CustomSourceConfig,
    type SourceSetupProbe,
} from "./source-config-form.tsx";
import type { SourceSetupDraft } from "./source-setup-draft.ts";
import {
    presetConfigSchema,
    sourceConfigSchema,
} from "../shared/source-schemas.ts";

interface SourceCreateDialogProps {
    readonly dashboard: DashboardData;
    readonly schemas: Readonly<Record<string, SourceConfigSchema>>;
    readonly presetPages: Readonly<Record<string, string>>;
    readonly policy?: UiPolicy;
    readonly proxyPool?: ProxyPoolView | null;
    readonly onClose: () => void;
    readonly onSaved: (draft: SourceSetupDraft) => void;
}

/** Catalog and transport integration for the single, in-place creation dialog. */
export function SourceCreateDialog(props: SourceCreateDialogProps) {
    const { dashboard, schemas, presetPages, policy } = props;
    const sources = dashboard.status.plugins.filter((plugin) =>
        plugin.kind === "source" && plugin.enabled
    ).map((plugin) => {
        const schema = schemas[plugin.id] ?? sourceConfigSchema(plugin.id);
        return {
            id: plugin.id,
            name: plugin.name || plugin.id,
            schema: schema.fields.length ? schema : undefined,
        };
    });
    const presets = dashboard.status.presets.filter((preset) =>
        sources.some((source) => source.id === preset.sourcePluginId) &&
        dashboard.status.plugins.some((plugin) =>
            plugin.id === preset.id && plugin.enabled
        )
    );
    const probe: SourceSetupProbe = (
        { draft, sourcePluginId, config },
        signal,
    ) => probeSourceDraft({
        id: draft.id,
        name: draft.name,
        priority: draft.priority,
        proxy: draft.proxy,
        modelMap: draft.modelMap,
        healthPolicy: draft.healthPolicy,
        sourcePluginId,
        ...(draft.mode === "preset" ? { presetId: draft.presetId } : {}),
        config,
    }, signal);
    return (
        <AddSourceFlow
            sources={sources}
            presets={presets}
            proxyPool={props.proxyPool}
            plugins={dashboard.status.plugins}
            onClose={props.onClose}
            onSaved={props.onSaved}
            onProbe={probe}
            onSave={async ({ draft, sourcePluginId, config }) => {
                await createSource({
                    id: draft.id,
                    name: draft.name,
                    priority: draft.priority,
                    proxy: draft.proxy,
                    modelMap: draft.modelMap,
                    middleware: draft.middleware,
                    healthPolicy: draft.healthPolicy,
                    sourcePluginId,
                    ...(draft.mode === "preset"
                        ? { presetId: draft.presetId }
                        : {}),
                    config,
                });
            }}
            renderPreset={(draft, controls) => {
                const preset = presets.find((item) =>
                    item.id === draft.presetId
                );
                if (!preset?.sourcePluginId) return undefined;
                const key = `${preset.id}:setup`;
                const moduleUrl = Object.hasOwn(presetPages, preset.id)
                    ? presetPages[preset.id]
                    : undefined;
                if (
                    safeUiAssetPath(moduleUrl, "js") &&
                    policy?.trustedModules &&
                    Object.hasOwn(policy.trustedModules, key) &&
                    policy.trustedModules[key] === moduleUrl
                ) {
                    return (
                        <PresetEditor
                            key={`${draft.id}:${preset.id}`}
                            moduleUrl={moduleUrl}
                            context={{
                                draft: {
                                    id: draft.id,
                                    name: draft.name,
                                    priority: draft.priority,
                                },
                                sourcePluginId: preset.sourcePluginId,
                                presetId: preset.id,
                                ...(draft.proxy ? { proxy: draft.proxy } : {}),
                                ...(draft.modelMap
                                    ? { modelMap: draft.modelMap }
                                    : {}),
                            }}
                            onSubmit={controls.onSave}
                            onModelMapChange={controls.onModelMapChange}
                            onProbe={(config, signal, modelMap) => {
                                if (modelMap !== undefined) {
                                    controls.onModelMapChange(modelMap);
                                }
                                return probe({
                                    draft: modelMap === undefined
                                        ? draft
                                        : { ...draft, modelMap },
                                    sourcePluginId: preset.sourcePluginId!,
                                    config,
                                }, signal);
                            }}
                            onPreview={async (config, modelMap) => {
                                if (modelMap !== undefined) {
                                    controls.onModelMapChange(modelMap);
                                }
                                controls.onBusyChange(true);
                                try {
                                    await previewPreset(preset.id, config);
                                } finally {
                                    controls.onBusyChange(false);
                                }
                            }}
                        />
                    );
                }
                const schema = schemas[preset.id] ??
                    presetConfigSchema(preset.id);
                if (!schema) return undefined;
                return (
                    <CustomSourceConfig
                        key={`${draft.id}:${preset.id}`}
                        draft={draft}
                        sources={[{
                            id: preset.sourcePluginId,
                            name: preset.name || preset.id,
                            schema,
                        }]}
                        sourcePluginId={preset.sourcePluginId}
                        hideSourceSelection
                        disabled={controls.busy}
                        onSelectSource={() => {}}
                        onSave={({ config }) => controls.onSave(config)}
                        onProbe={probe}
                        onModelMapChange={controls.onModelMapChange}
                    />
                );
            }}
        />
    );
}

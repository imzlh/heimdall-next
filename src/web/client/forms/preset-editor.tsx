/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type {
    PresetJsonObject,
    PresetUiContext,
} from "@heimdall/admin-contracts/preset-ui.ts";
import { safeUiAssetPath } from "@heimdall/admin-contracts/ui.ts";
import { sourceProxyValue } from "../../shared/proxy-presentation.ts";
import type { SourceModelMap } from "@heimdall/admin-contracts/source-model-map.ts";
import {
    mountPresetEditor,
    type PresetEditorActions,
    type PresetUiModule,
} from "./preset-bridge.ts";

export interface PresetEditorProps extends PresetEditorActions {
    /** Exact self-hosted URL selected from the host's explicit preset registry. */
    readonly moduleUrl: string;
    readonly context: PresetUiContext;
}

/** One isolated DOM root; only validated JSON events cross into the host. */
export function PresetEditor(props: PresetEditorProps) {
    const root = useRef<HTMLDivElement | null>(null);
    const handlers = useRef<PresetEditorActions>(props);
    const [status, setStatus] = useState<"loading" | "ready" | "error">(
        "loading",
    );
    handlers.current = props;
    const { moduleUrl, context } = props;
    useEffect(() => {
        const element = root.current;
        if (!element) return;
        setStatus("loading");
        if (!safeUiAssetPath(moduleUrl, "js")) {
            setStatus("error");
            return;
        }
        // After returning to the previous step, a late mount only sees a detached root.
        const stage = document.createElement("div");
        stage.className = "preset-editor-stage";
        element.append(stage);
        let cleanup: (() => void | Promise<void>) | undefined;
        try {
            cleanup = mountPresetEditor(
                stage,
                context,
                () => import(moduleUrl) as Promise<PresetUiModule>,
                {
                    onModelMapChange: (modelMap) =>
                        handlers.current!.onModelMapChange?.(modelMap),
                    onSubmit: (config, modelMap) =>
                        handlers.current!.onSubmit(config, modelMap),
                    ...(props.onPreview
                        ? {
                            onPreview: (
                                config: PresetJsonObject,
                                modelMap?: SourceModelMap,
                            ) => handlers.current!.onPreview!(config, modelMap),
                        }
                        : {}),
                    ...(props.onProbe
                        ? {
                            onProbe: (
                                config: PresetJsonObject,
                                signal: AbortSignal,
                                modelMap?: SourceModelMap,
                            ) => handlers.current!.onProbe!(
                                config,
                                signal,
                                modelMap,
                            ),
                        }
                        : {}),
                },
                () => setStatus("ready"),
                () => setStatus("error"),
            );
        } catch {
            setStatus("error");
        }
        return () => {
            stage.remove();
            void cleanup?.();
        };
    }, [
        moduleUrl,
        context.presetId,
        context.sourcePluginId,
        context.draft.id,
        context.draft.name,
        context.draft.priority,
        sourceProxyValue(context.proxy),
        !!props.onPreview,
        !!props.onProbe,
    ]);
    return (
        <div
            class="preset-editor"
            aria-busy={status === "loading" ? "true" : "false"}
        >
            {status === "loading" && <p role="status">正在加载预设配置…</p>}
            {status === "error" && (
                <p class="form-error" role="alert">
                    预设配置加载失败，请返回上一步重新选择。
                </p>
            )}
            <div
                ref={root}
                class="preset-editor-root"
                hidden={status !== "ready"}
            />
        </div>
    );
}

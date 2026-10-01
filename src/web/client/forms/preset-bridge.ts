import {
    parsePresetUiAction,
    parsePresetUiContext,
    parsePresetUiFeedback,
    parsePresetUiModelMap,
    PRESET_UI_ACTION_EVENT,
    PRESET_UI_FEEDBACK_EVENT,
    PRESET_UI_MODEL_MAP_EVENT,
    type PresetJsonObject,
    type PresetUiContext,
    type PresetUiFeedback,
} from "@heimdall/admin-contracts/preset-ui.ts";
import type { SourceDraftProbeResult } from "@heimdall/admin-contracts/source-probe.ts";
import type { SourceModelMap } from "@heimdall/admin-contracts/source-model-map.ts";

export type PresetUiCleanup = () => void | Promise<void>;
export interface PresetUiModule {
    mount(
        element: HTMLElement,
        context: PresetUiContext,
    ): void | PresetUiCleanup | Promise<void | PresetUiCleanup>;
}

export interface PresetEditorActions {
    readonly onModelMapChange?: (modelMap: SourceModelMap) => void;
    readonly onSubmit: (
        config: PresetJsonObject,
        modelMap?: SourceModelMap,
    ) => Promise<void>;
    readonly onPreview?: (
        config: PresetJsonObject,
        modelMap?: SourceModelMap,
    ) => Promise<PresetJsonObject | void>;
    readonly onProbe?: (
        config: PresetJsonObject,
        signal: AbortSignal,
        modelMap?: SourceModelMap,
    ) => Promise<SourceDraftProbeResult>;
}

/** The caller supplies a host-approved loader; plugin metadata cannot select it. */
export function mountPresetEditor(
    element: HTMLElement,
    context: PresetUiContext,
    load: () => Promise<PresetUiModule>,
    actions: PresetEditorActions,
    ready: () => void,
    report: () => void,
): PresetUiCleanup {
    const safeContext = parsePresetUiContext(context);
    let disposed = false;
    let failed = false;
    let busy = false;
    let saved = false;
    const lifetime = new AbortController();
    let cleanup: PresetUiCleanup | undefined;
    const feedback = (value: PresetUiFeedback) => {
        if (disposed || failed) return;
        element.dispatchEvent(
            new CustomEvent(PRESET_UI_FEEDBACK_EVENT, {
                detail: parsePresetUiFeedback(value),
            }),
        );
    };
    const receive = (event: Event) => {
        if (
            disposed || failed || busy || saved || event.target !== element ||
            !(event instanceof CustomEvent)
        ) return;
        let action;
        try {
            action = parsePresetUiAction(event.detail);
        } catch {
            feedback({
                kind: "save",
                status: "error",
                errors: { _form: "无法读取预设配置，请检查输入后重试。" },
            });
            return;
        }
        if (action.kind === "preview" && !actions.onPreview) {
            feedback({
                kind: "preview",
                status: "error",
                errors: { _form: "此预设暂不支持预览。" },
            });
            return;
        }
        if (action.kind === "probe" && !actions.onProbe) {
            feedback({
                kind: "probe",
                status: "error",
                errors: { _form: "此预设暂不支持连接测试，可以直接保存。" },
            });
            return;
        }
        busy = true;
        feedback({ kind: action.kind, status: "pending" });
        void (async () => {
            try {
                let probe: SourceDraftProbeResult | undefined;
                if (action.kind === "save") {
                    await actions.onSubmit(action.config, action.modelMap);
                    saved = true;
                } else if (action.kind === "probe") {
                    probe = await actions.onProbe!(
                        action.config,
                        lifetime.signal,
                        action.modelMap,
                    );
                } else await actions.onPreview!(action.config, action.modelMap);
                feedback({
                    kind: action.kind,
                    status: "success",
                    ...(probe ? { probe } : {}),
                });
            } catch {
                feedback({
                    kind: action.kind,
                    status: "error",
                    errors: {
                        _form: action.kind === "save"
                            ? "保存失败，请检查配置和登录状态后重试。"
                            : action.kind === "probe"
                            ? "连接测试失败，请检查配置和登录状态后重试。"
                            : "预览失败，请检查配置后重试。",
                    },
                });
            } finally {
                busy = false;
            }
        })();
    };
    const release = async () => {
        const callback = cleanup;
        cleanup = undefined;
        try {
            await callback?.();
        } catch { /* Plugin cleanup cannot interrupt the host page. */ }
    };
    const receiveModelMap = (event: Event) => {
        if (
            disposed || failed || busy || saved || event.target !== element ||
            !(event instanceof CustomEvent)
        ) return;
        try {
            actions.onModelMapChange?.(parsePresetUiModelMap(event.detail));
        } catch {
            feedback({
                kind: "save",
                status: "error",
                errors: { _form: "模型映射无效，请检查模型名称后重试。" },
            });
        }
    };
    element.addEventListener(PRESET_UI_ACTION_EVENT, receive);
    element.addEventListener(PRESET_UI_MODEL_MAP_EVENT, receiveModelMap);
    void Promise.resolve().then(load).then(async (module) => {
        if (disposed) return;
        if (typeof module.mount !== "function") {
            throw new TypeError("Preset UI must export mount");
        }
        const result = await module.mount(element, safeContext);
        if (typeof result === "function") cleanup = result;
        if (disposed) await release();
        else ready();
    }).catch(() => {
        if (disposed) return;
        failed = true;
        element.removeEventListener(PRESET_UI_ACTION_EVENT, receive);
        element.removeEventListener(PRESET_UI_MODEL_MAP_EVENT, receiveModelMap);
        report();
    });
    return async () => {
        if (disposed) return;
        disposed = true;
        lifetime.abort();
        element.removeEventListener(PRESET_UI_ACTION_EVENT, receive);
        element.removeEventListener(PRESET_UI_MODEL_MAP_EVENT, receiveModelMap);
        await release();
    };
}

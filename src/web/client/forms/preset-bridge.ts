import {
    parsePresetUiAction,
    parsePresetUiContext,
    parsePresetUiFeedback,
    PRESET_UI_ACTION_EVENT,
    PRESET_UI_FEEDBACK_EVENT,
    type PresetJsonObject,
    type PresetUiContext,
    type PresetUiFeedback,
} from "@heimdall/admin-contracts/preset-ui.ts";

export type PresetUiCleanup = () => void | Promise<void>;
export interface PresetUiModule {
    mount(
        element: HTMLElement,
        context: PresetUiContext,
    ): void | PresetUiCleanup | Promise<void | PresetUiCleanup>;
}

export interface PresetEditorActions {
    readonly onSubmit: (config: PresetJsonObject) => Promise<void>;
    readonly onPreview?: (
        config: PresetJsonObject,
    ) => Promise<PresetJsonObject | void>;
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
        busy = true;
        feedback({ kind: action.kind, status: "pending" });
        void (async () => {
            try {
                if (action.kind === "save") {
                    await actions.onSubmit(action.config);
                    saved = true;
                } else await actions.onPreview!(action.config);
                feedback({ kind: action.kind, status: "success" });
            } catch {
                feedback({
                    kind: action.kind,
                    status: "error",
                    errors: {
                        _form: action.kind === "save"
                            ? "保存失败，请检查配置和登录状态后重试。"
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
    element.addEventListener(PRESET_UI_ACTION_EVENT, receive);
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
        report();
    });
    return async () => {
        if (disposed) return;
        disposed = true;
        element.removeEventListener(PRESET_UI_ACTION_EVENT, receive);
        await release();
    };
}

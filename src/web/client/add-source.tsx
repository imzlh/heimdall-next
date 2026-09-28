/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useLayoutEffect, useRef, useState } from "hono/jsx/dom";
import type { Child } from "hono/jsx";
import type { PresetJsonObject } from "@heimdall/admin-contracts/preset-ui.ts";
import type {
    ProxyPoolView,
    SourceProxySelection,
} from "@heimdall/admin-contracts/proxies.ts";
import { controlValue } from "./dom.ts";
import { Icon } from "../shared/icons.tsx";
import { SourceProxySelect } from "./source-proxy-select.tsx";
import { sourceProxyLabel } from "../shared/proxy-presentation.ts";
import { describeError, type ListedPreset } from "./api/admin.ts";
import {
    createSourceSetupDraft,
    type SourceSetupDraft,
} from "./source-setup-draft.ts";
import {
    CustomSourceConfig,
    type SourceSetupProbe,
    type SourceSetupSaveInput,
    type SourceSetupSource,
} from "./source-config-form.tsx";

export type AddSourceStep = "details" | "choice" | "configure";

export interface PresetFlowControls {
    readonly busy: boolean;
    readonly onSave: (config: PresetJsonObject) => Promise<void>;
    readonly onBusyChange: (busy: boolean) => void;
}

export interface AddSourceFlowProps {
    readonly presets: readonly ListedPreset[];
    readonly sources: readonly SourceSetupSource[];
    readonly initialDraft?: SourceSetupDraft;
    readonly initialStep?: AddSourceStep;
    readonly proxyPool?: ProxyPoolView | null;
    readonly onClose: () => void;
    readonly onSave: (input: SourceSetupSaveInput) => Promise<void>;
    readonly onProbe?: SourceSetupProbe;
    readonly onSaved?: (draft: SourceSetupDraft) => void;
    /** Only the host selects a preset renderer and its module permissions. */
    readonly renderPreset?: (
        draft: SourceSetupDraft,
        controls: PresetFlowControls,
    ) => Child;
}

/** All three steps replace content in one dialog; drafts never leave memory. */
export function AddSourceFlow(
    {
        presets,
        sources,
        initialDraft,
        initialStep = "details",
        proxyPool,
        onClose,
        onSave,
        onProbe,
        onSaved,
        renderPreset,
    }: AddSourceFlowProps,
) {
    const dialog = useRef<HTMLDialogElement | null>(null);
    const nameInput = useRef<HTMLInputElement | null>(null);
    const priorityInput = useRef<HTMLInputElement | null>(null);
    const heading = useRef<HTMLHeadingElement | null>(null);
    const mounted = useRef(true);
    const closed = useRef(false);
    const pending = useRef(false);
    const closeResult = useRef<SourceSetupDraft | undefined>(undefined);
    const callbacks = useRef({ onClose, onSaved });
    callbacks.current = { onClose, onSaved };
    const [busy, setBusy] = useState(false);
    const [closing, setClosing] = useState(false);
    const [direction, setDirection] = useState<"forward" | "back">("forward");
    const [step, setStep] = useState<AddSourceStep>(
        initialStep === "configure" && !initialDraft ? "details" : initialStep,
    );
    const [draft, setDraft] = useState<SourceSetupDraft | undefined>(
        initialDraft,
    );
    const [name, setName] = useState(initialDraft?.name ?? "");
    const [priority, setPriority] = useState(
        String(initialDraft?.priority ?? 0),
    );
    const [proxy, setProxy] = useState<SourceProxySelection>(
        initialDraft?.proxy ?? { mode: "inherit" },
    );
    const configurable = sources.filter((source) => source.schema);
    const [sourcePluginId, setSourcePluginId] = useState(
        configurable.length === 1 ? configurable[0]!.id : "",
    );
    const [error, setError] = useState("");
    const [errorField, setErrorField] = useState<"name" | "priority" | null>(
        null,
    );

    useEffect(() => {
        const element = dialog.current;
        const trigger = document.activeElement as HTMLElement | null;
        mounted.current = true;
        if (element && !element.open) element.showModal();
        return () => {
            mounted.current = false;
            closed.current = true;
            if (element?.open) element.close();
            if (trigger?.isConnected) trigger.focus();
        };
    }, []);

    useLayoutEffect(() => {
        if (!closing) return;
        const element = dialog.current;
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const detach = () => {
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            element?.removeEventListener("animationend", ended);
            element?.removeEventListener("animationcancel", ended);
        };
        const finish = () => {
            if (finished) return;
            finished = true;
            detach();
            if (!mounted.current) return;
            element?.close();
            try {
                if (closeResult.current) {
                    callbacks.current?.onSaved?.(closeResult.current);
                }
            } finally {
                callbacks.current?.onClose();
            }
        };
        const ended = (event: Event) => {
            if (
                event.target === element &&
                (event as AnimationEvent).animationName === "source-dialog-out"
            ) finish();
        };
        const motion = globalThis.matchMedia?.(
            "(prefers-reduced-motion: reduce)",
        );
        if (!element || !motion || motion.matches) {
            finish();
            return;
        }
        element.addEventListener("animationend", ended);
        element.addEventListener("animationcancel", ended);
        // Finish even when CSS is unavailable, animations are interrupted or a
        // background document omits animation events. The CSS duration is 150ms.
        timer = setTimeout(finish, 250);
        return detach;
    }, [closing]);

    useEffect(() => {
        if (step === "details") nameInput.current?.focus();
        else heading.current?.focus();
        dialog.current?.scrollTo?.({ top: 0 });
    }, [step]);

    function close() {
        if (pending.current || closed.current) return;
        closed.current = true;
        setBusy(true);
        setClosing(true);
    }

    function move(to: AddSourceStep, direction: "forward" | "back") {
        setDirection(direction);
        setStep(to);
    }

    function clearError(field: "name" | "priority") {
        if (errorField !== field) return;
        setError("");
        setErrorField(null);
    }

    function next(event: Event) {
        event.preventDefault();
        if (pending.current || closed.current) return;
        if (!name.trim() || name.trim().length > 120) {
            setError("请输入 1 至 120 个字符的渠道名称。");
            setErrorField("name");
            nameInput.current?.focus();
            return;
        }
        if (!priority.trim() || !Number.isSafeInteger(Number(priority))) {
            setError("优先级必须是安全范围内的整数。");
            setErrorField("priority");
            priorityInput.current?.focus();
            return;
        }
        setError("");
        setErrorField(null);
        move("choice", "forward");
    }

    function choose(presetId?: string) {
        if (pending.current || closed.current) return;
        try {
            const selected = presetId
                ? presets.find((item) => item.id === presetId)
                : undefined;
            if (
                presetId &&
                (!selected?.sourcePluginId ||
                    !sources.some((source) =>
                        source.id === selected.sourcePluginId
                    ))
            ) {
                throw new Error("此预设的源插件暂不可用，请选择其他配置方式。");
            }
            setDraft(createSourceSetupDraft({
                name,
                priority: Number(priority),
                proxy,
                mode: presetId ? "preset" : "custom",
                ...(presetId ? { presetId } : {}),
            }, draft?.id));
            setError("");
            move("configure", "forward");
        } catch (cause) {
            setError(describeError(cause));
        }
    }

    function back(to: "details" | "choice") {
        if (pending.current || closed.current) return;
        setError("");
        setErrorField(null);
        move(to, "back");
    }

    async function save(input: SourceSetupSaveInput) {
        if (pending.current || closed.current || !mounted.current) {
            throw new Error("当前操作尚未结束，请稍后重试。");
        }
        if (!sources.some((source) => source.id === input.sourcePluginId)) {
            throw new Error("源插件已不可用，请返回重新选择。");
        }
        pending.current = true;
        setBusy(true);
        try {
            await onSave(input);
        } catch (cause) {
            pending.current = false;
            if (mounted.current) setBusy(false);
            throw cause;
        }
        if (!mounted.current) return;
        closed.current = true;
        closeResult.current = input.draft;
        setClosing(true);
    }

    const selectedPreset = draft?.mode === "preset"
        ? presets.find((item) => item.id === draft.presetId)
        : undefined;
    const configure = step === "configure" && draft;
    const configurationTitle = draft?.mode === "preset"
        ? selectedPreset?.name || draft.presetId || "预设配置"
        : "填写连接参数";
    const stepIndex = ["details", "choice", "configure"].indexOf(step);
    const stepLabel = ["基本信息", "配置方式", "完成配置"][stepIndex];
    const title = step === "details"
        ? "添加渠道"
        : step === "choice"
        ? "选择配置方式"
        : configurationTitle;

    return (
        <dialog
            ref={dialog}
            class={`source-dialog source-create-dialog${
                configure ? " source-dialog-configure" : ""
            }${closing ? " is-closing" : ""}`}
            data-direction={direction}
            aria-labelledby="add-source-title"
            aria-busy={busy ? "true" : "false"}
            onCancel={(event: Event) => {
                event.preventDefault();
                close();
            }}
        >
            <div class="panel-heading source-dialog-header">
                <div>
                    <h2 id="add-source-title" ref={heading} tabIndex={-1}>
                        {title}
                    </h2>
                    <p class="source-flow-progress" aria-label="添加渠道步骤">
                        <span>{stepIndex + 1} / 3</span>
                        <span>{stepLabel}</span>
                    </p>
                </div>
                <button
                    type="button"
                    class="icon-button"
                    aria-label="关闭"
                    title="关闭"
                    disabled={busy}
                    onClick={close}
                >
                    <Icon name="close" />
                    <span class="sr-only">关闭</span>
                </button>
            </div>
            {step !== "details" && (
                <p class="source-flow-context" id="source-flow-context">
                    <span>{name.trim()}</span>
                    <span>优先级 {priority}</span>
                    <span>{sourceProxyLabel(proxy, proxyPool)}</span>
                </p>
            )}
            {step === "details" && (
                <form
                    key="details"
                    class="source-flow-content source-flow-details"
                    onSubmit={next}
                    noValidate
                >
                    <div class="source-flow-body">
                        <label>
                            渠道名称<input
                                ref={nameInput}
                                autoFocus
                                required
                                maxLength={120}
                                value={name}
                                placeholder="例如：主力模型服务"
                                aria-invalid={errorField === "name"
                                    ? "true"
                                    : "false"}
                                aria-describedby={errorField === "name"
                                    ? "source-details-error"
                                    : undefined}
                                onInput={(event) => {
                                    setName(controlValue(event));
                                    clearError("name");
                                }}
                            />
                        </label>
                        <label>
                            优先级<input
                                ref={priorityInput}
                                required
                                type="number"
                                step="1"
                                value={priority}
                                aria-invalid={errorField === "priority"
                                    ? "true"
                                    : "false"}
                                aria-describedby={errorField === "priority"
                                    ? "source-details-error"
                                    : undefined}
                                onInput={(event) => {
                                    setPriority(controlValue(event));
                                    clearError("priority");
                                }}
                            />
                        </label>
                        <SourceProxySelect
                            value={proxy}
                            pool={proxyPool}
                            disabled={busy}
                            onChange={setProxy}
                        />
                        {error && (
                            <p
                                id="source-details-error"
                                class="form-error"
                                role="alert"
                            >
                                {error}
                            </p>
                        )}
                    </div>
                    <div class="config-actions source-flow-footer">
                        <button
                            type="button"
                            class="text-button"
                            onClick={close}
                        >
                            取消
                        </button>
                        <button type="submit" class="primary-button">
                            下一步
                        </button>
                    </div>
                </form>
            )}
            {step === "choice" && (
                <div
                    key="choice"
                    class="source-flow-content source-flow-choice"
                >
                    <div class="source-flow-body">
                        <div
                            class="template-options"
                            role="group"
                            aria-labelledby="add-source-title"
                            aria-describedby="source-flow-context"
                        >
                            {presets.map((preset) => (
                                <button
                                    type="button"
                                    class="template-option template-option-link"
                                    key={preset.id}
                                    aria-pressed={draft?.mode === "preset" &&
                                            draft.presetId === preset.id
                                        ? "true"
                                        : "false"}
                                    onClick={() => choose(preset.id)}
                                >
                                    <span class="template-option-body">
                                        <strong class="template-option-title">
                                            {preset.name || preset.id}
                                        </strong>
                                        {preset.sourcePluginId && (
                                            <span class="template-option-description">
                                                {sources.find((source) =>
                                                    source.id ===
                                                        preset.sourcePluginId
                                                )?.name ||
                                                    preset.sourcePluginId}
                                            </span>
                                        )}
                                    </span>
                                    <Icon
                                        name="chevron-right"
                                        class="template-option-arrow"
                                    />
                                </button>
                            ))}
                            <button
                                type="button"
                                class="template-option template-option-link"
                                aria-pressed={draft?.mode === "custom"
                                    ? "true"
                                    : "false"}
                                onClick={() => choose()}
                            >
                                <span class="template-option-body">
                                    <strong class="template-option-title">
                                        自定义配置
                                    </strong>
                                    <span class="template-option-description">
                                        手动填写连接参数
                                    </span>
                                </span>
                                <Icon
                                    name="chevron-right"
                                    class="template-option-arrow"
                                />
                            </button>
                        </div>
                        {error && (
                            <p class="form-error" role="alert">{error}</p>
                        )}
                    </div>
                    <div class="config-actions source-flow-footer">
                        <button
                            type="button"
                            class="icon-button"
                            aria-label="上一步"
                            title="上一步"
                            onClick={() => back("details")}
                        >
                            <Icon name="arrow-left" />
                            <span class="sr-only">上一步</span>
                        </button>
                    </div>
                </div>
            )}
            {configure && (
                <div
                    key="configure"
                    class="source-flow-content source-flow-configure"
                >
                    {draft.mode === "preset"
                        ? (
                            <div
                                class="source-preset-config"
                                aria-labelledby="add-source-title"
                            >
                                {renderPreset?.(draft, {
                                    busy,
                                    onSave: (config) => {
                                        if (!selectedPreset?.sourcePluginId) {
                                            return Promise.reject(
                                                new Error(
                                                    "预设来源不可用，请重新选择。",
                                                ),
                                            );
                                        }
                                        return save({
                                            draft,
                                            sourcePluginId:
                                                selectedPreset.sourcePluginId,
                                            config,
                                        });
                                    },
                                    onBusyChange: (value) => {
                                        if (
                                            closed.current || !mounted.current
                                        ) return;
                                        pending.current = value;
                                        setBusy(value);
                                    },
                                }) ?? (
                                    <p class="empty-state source-flow-body">
                                        此预设暂不可用，请返回选择其他预设或自定义配置。
                                    </p>
                                )}
                                <div class="config-actions source-flow-footer source-flow-back">
                                    <button
                                        type="button"
                                        class="icon-button"
                                        aria-label="上一步"
                                        title="上一步"
                                        disabled={busy}
                                        onClick={() => back("choice")}
                                    >
                                        <Icon name="arrow-left" />
                                        <span class="sr-only">上一步</span>
                                    </button>
                                </div>
                            </div>
                        )
                        : (
                            <CustomSourceConfig
                                draft={draft}
                                sources={sources}
                                sourcePluginId={sourcePluginId}
                                disabled={busy}
                                onSelectSource={setSourcePluginId}
                                onSave={save}
                                onProbe={onProbe}
                                onBack={() => back("choice")}
                            />
                        )}
                </div>
            )}
        </dialog>
    );
}

/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useLayoutEffect, useRef, useState } from "hono/jsx/dom";
import type { UpdateSourceInput } from "@heimdall/admin-contracts";
import type {
    ProxyPoolView,
    SourceProxySelection,
} from "@heimdall/admin-contracts/proxies.ts";
import { sourceProxyValue } from "../shared/proxy-presentation.ts";
import { SourceProxySelect } from "./source-proxy-select.tsx";
import {
    sameSourceMiddleware,
    SourceMiddlewareSelect,
} from "./source-middleware-select.tsx";
import type { ListedPlugin } from "@heimdall/admin-contracts/console.ts";
import type { SourceModelMap } from "@heimdall/admin-contracts/source-model-map.ts";
import type { SourceHealthPolicy } from "@heimdall/admin-contracts/source-health.ts";
import {
    readSourceHealthPolicyDraft,
    sameSourceHealthPolicy,
    sourceHealthPolicyDraft,
    SourceHealthPolicyEditor,
} from "./source-health-policy.tsx";
import {
    readSourceModelMapRows,
    sameSourceModelMap,
    SourceModelMapEditor,
    type SourceModelMapRow,
    sourceModelMapRows,
} from "./forms/source-model-map.tsx";
import {
    AdminApiError,
    deleteSource,
    describeError,
    type ListedSource,
    loadSourceMetadata,
    updateSource,
} from "./api/admin.ts";
import { controlValue } from "./dom.ts";
import { Icon } from "../shared/icons.tsx";

export function sourceManagementError(error: unknown): string {
    if (error instanceof AdminApiError && error.status === 409) {
        return `渠道已被修改，请读取最新信息后再操作。${
            error.requestId ? ` · request ${error.requestId}` : ""
        }`;
    }
    return describeError(error);
}

interface SourceManagementProps {
    readonly source: ListedSource;
    readonly proxyPool?: ProxyPoolView | null;
    readonly plugins?: readonly ListedPlugin[];
    readonly onClose: () => void;
    readonly onChanged: (
        kind: "saved" | "deleted",
        source: ListedSource,
    ) => void;
}

/** Instance identity, provider configuration and plugin state are separate edits. */
export function SourceManagementDialog(
    { source, proxyPool, plugins, onClose, onChanged }: SourceManagementProps,
) {
    const dialog = useRef<HTMLDialogElement | null>(null);
    const nameInput = useRef<HTMLInputElement | null>(null);
    const priorityInput = useRef<HTMLInputElement | null>(null);
    const cancelDelete = useRef<HTMLButtonElement | null>(null);
    const mounted = useRef(true);
    const pending = useRef(false);
    const callbacks = useRef({ onClose, onChanged });
    callbacks.current = { onClose, onChanged };
    const [baseline, setBaseline] = useState(source);
    const [name, setName] = useState(source.name || source.id || "");
    const [priority, setPriority] = useState(String(source.priority ?? 0));
    const [proxy, setProxy] = useState<SourceProxySelection>(
        source.proxy ?? { mode: "inherit" },
    );
    const [middleware, setMiddleware] = useState<readonly string[] | null>(
        source.middleware ?? null,
    );
    const [healthDraft, setHealthDraft] = useState(() =>
        sourceHealthPolicyDraft(source.healthPolicy)
    );
    const [modelRows, setModelRows] = useState<readonly SourceModelMapRow[]>(
        sourceModelMapRows(source.modelMap),
    );
    const [view, setView] = useState<"edit" | "delete">("edit");
    const [action, setAction] = useState<"save" | "delete" | "reload" | "">("");
    const [closing, setClosing] = useState(false);
    const [error, setError] = useState("");
    const [conflict, setConflict] = useState(false);
    const [notice, setNotice] = useState("");
    const [errorField, setErrorField] = useState<
        "name" | "priority" | "modelMap" | "healthPolicy" | ""
    >("");
    const busy = Boolean(action) || closing;
    const configurationErrorField = baseline.configurationError
        ? baseline.configurationErrorField ?? "middleware"
        : undefined;

    useEffect(() => {
        const element = dialog.current;
        const trigger = document.activeElement as HTMLElement | null;
        mounted.current = true;
        if (element && !element.open) element.showModal();
        nameInput.current?.focus();
        return () => {
            mounted.current = false;
            if (element?.open) element.close();
            if (trigger?.isConnected) trigger.focus();
        };
    }, []);

    useLayoutEffect(() => {
        if (!closing) return;
        const element = dialog.current;
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            if (finished || !mounted.current) return;
            finished = true;
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            element?.close();
            callbacks.current?.onClose();
        };
        const ended = (event: Event) => {
            if (
                event.target === element &&
                (event as AnimationEvent).animationName === "source-dialog-out"
            ) finish();
        };
        if (
            !globalThis.matchMedia ||
            globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
            finish();
            return;
        }
        element?.addEventListener("animationend", ended);
        element?.addEventListener("animationcancel", ended);
        timer = setTimeout(finish, 250);
        return () => {
            if (timer !== undefined) clearTimeout(timer);
            element?.removeEventListener("animationend", ended);
            element?.removeEventListener("animationcancel", ended);
        };
    }, [closing]);

    useEffect(() => {
        if (view === "delete") cancelDelete.current?.focus();
        else nameInput.current?.focus();
    }, [view]);

    function close() {
        if (!pending.current) setClosing(true);
    }

    function edit(field: "name" | "priority", value: string) {
        if (field === "name") setName(value);
        else setPriority(value);
        if (errorField === field) {
            setError("");
            setErrorField("");
        }
    }

    async function run(kind: "save" | "delete" | "reload") {
        if (pending.current || closing || !baseline.id) return;
        if (conflict && kind !== "reload") return;
        const changes: {
            name?: string;
            priority?: number;
            proxy?: SourceProxySelection;
            modelMap?: SourceModelMap;
            middleware?: readonly string[] | null;
            healthPolicy?: SourceHealthPolicy | null;
        } = {};
        if (kind === "save") {
            if (!name.trim() || name.trim().length > 120) {
                setError("渠道名称不能为空，且不能超过 120 个字符。");
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
            if (name.trim() !== (baseline.name || baseline.id)) {
                changes.name = name.trim();
            }
            if (Number(priority) !== (baseline.priority ?? 0)) {
                changes.priority = Number(priority);
            }
            if (sourceProxyValue(proxy) !== sourceProxyValue(baseline.proxy)) {
                changes.proxy = proxy;
            }
            if (
                configurationErrorField === "middleware" ||
                !sameSourceMiddleware(middleware, baseline.middleware)
            ) {
                changes.middleware = middleware;
            }
            try {
                const healthPolicy = readSourceHealthPolicyDraft(healthDraft);
                if (
                    configurationErrorField === "healthPolicy" ||
                    !sameSourceHealthPolicy(healthPolicy, baseline.healthPolicy)
                ) {
                    changes.healthPolicy = healthPolicy;
                }
            } catch (cause) {
                setError(describeError(cause));
                setErrorField("healthPolicy");
                return;
            }
            try {
                const modelMap = readSourceModelMapRows(modelRows);
                if (
                    configurationErrorField === "modelMap" ||
                    !sameSourceModelMap(modelMap, baseline.modelMap)
                ) {
                    changes.modelMap = modelMap;
                }
            } catch (cause) {
                setError(describeError(cause));
                setErrorField("modelMap");
                return;
            }
            if (!Object.keys(changes).length) {
                close();
                return;
            }
        }
        pending.current = true;
        setAction(kind);
        setError("");
        setErrorField("");
        setNotice("");
        try {
            if (kind === "reload") {
                const latest = await loadSourceMetadata(baseline.id);
                if (!mounted.current) return;
                if (name.trim() === (baseline.name || baseline.id)) {
                    setName(latest.name || latest.id || "");
                }
                if (Number(priority) === (baseline.priority ?? 0)) {
                    setPriority(String(latest.priority ?? 0));
                }
                if (
                    sourceProxyValue(proxy) === sourceProxyValue(baseline.proxy)
                ) {
                    setProxy(latest.proxy ?? { mode: "inherit" });
                }
                if (sameSourceMiddleware(middleware, baseline.middleware)) {
                    setMiddleware(latest.middleware ?? null);
                }
                try {
                    if (
                        sameSourceHealthPolicy(
                            readSourceHealthPolicyDraft(healthDraft),
                            baseline.healthPolicy,
                        )
                    ) {
                        setHealthDraft(
                            sourceHealthPolicyDraft(latest.healthPolicy),
                        );
                    }
                } catch {
                    /* Keep incomplete local seconds while adopting the latest revision. */
                }
                try {
                    if (
                        sameSourceModelMap(
                            readSourceModelMapRows(modelRows),
                            baseline.modelMap,
                        )
                    ) {
                        setModelRows(sourceModelMapRows(latest.modelMap));
                    }
                } catch {
                    /* Preserve incomplete operator edits while reloading the revision. */
                }
                setBaseline(latest);
                setConflict(false);
                setNotice("已读取最新信息并保留你的修改，请核对后继续。");
                return;
            }
            if (kind === "save") {
                await updateSource(
                    baseline.id,
                    changes satisfies UpdateSourceInput,
                    baseline.versionstamp,
                );
            } else {
                await deleteSource(baseline.id, baseline.versionstamp);
            }
            if (!mounted.current) return;
            const updated = { ...baseline, ...changes };
            if (
                kind === "save" &&
                ((configurationErrorField === "middleware" &&
                    changes.middleware !== undefined) ||
                    (configurationErrorField === "modelMap" &&
                        changes.modelMap !== undefined) ||
                    (configurationErrorField === "healthPolicy" &&
                        changes.healthPolicy !== undefined))
            ) {
                delete updated.configurationError;
                delete updated.configurationErrorField;
                setBaseline(updated);
            }
            callbacks.current?.onChanged(
                kind === "save" ? "saved" : "deleted",
                updated,
            );
            setClosing(true);
        } catch (caught) {
            if (!mounted.current) return;
            if (caught instanceof AdminApiError && caught.status === 409) {
                setConflict(true);
            }
            setError(sourceManagementError(caught));
        } finally {
            pending.current = false;
            if (mounted.current) setAction("");
        }
    }

    return (
        <dialog
            ref={dialog}
            class={`source-dialog source-management-dialog${
                closing ? " is-closing" : ""
            }`}
            aria-labelledby="source-management-title"
            aria-busy={busy ? "true" : "false"}
            onCancel={(event: Event) => {
                event.preventDefault();
                close();
            }}
        >
            <div class="panel-heading">
                <div>
                    <p class="eyebrow">渠道管理</p>
                    <h2 id="source-management-title">
                        {view === "edit" ? "编辑基础信息" : "删除渠道"}
                    </h2>
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
            <p class="source-management-id">
                <code>{baseline.id}</code>
            </p>
            {baseline.configurationError && (
                <div class="source-configuration-error">
                    <p class="form-error" role="alert">
                        {baseline.configurationError}
                    </p>
                    {view === "edit" && (
                        <p class="field-help">
                            {configurationErrorField === "modelMap"
                                ? "确认下方模型映射后保存即可修复；留空表示移除模型映射。"
                                : configurationErrorField === "config"
                                ? "请通过渠道卡的「配置」入口修复连接参数。"
                                : configurationErrorField === "healthPolicy"
                                ? "确认下方健康策略后保存即可修复；选择继承全局会清除损坏的策略。"
                                : "确认下方中间件设置后保存即可修复配置；空列表表示不使用中间件。"}
                        </p>
                    )}
                </div>
            )}
            {view === "edit"
                ? (
                    <form
                        noValidate
                        onSubmit={(event: Event) => {
                            event.preventDefault();
                            void run("save");
                        }}
                    >
                        <label>
                            渠道名称
                            <input
                                ref={nameInput}
                                name="source-name"
                                value={name}
                                maxLength={120}
                                required
                                disabled={busy}
                                aria-invalid={errorField === "name"
                                    ? "true"
                                    : "false"}
                                aria-describedby={errorField === "name"
                                    ? "source-management-error"
                                    : undefined}
                                onInput={(event) =>
                                    edit("name", controlValue(event))}
                            />
                        </label>
                        <label>
                            优先级
                            <input
                                ref={priorityInput}
                                name="source-priority"
                                type="number"
                                step="1"
                                value={priority}
                                required
                                disabled={busy}
                                aria-invalid={errorField === "priority"
                                    ? "true"
                                    : "false"}
                                aria-describedby={errorField === "priority"
                                    ? "source-priority-help source-management-error"
                                    : "source-priority-help"}
                                onInput={(event) =>
                                    edit("priority", controlValue(event))}
                            />
                        </label>
                        <p id="source-priority-help" class="field-help">
                            数值越小，路由时越优先使用此渠道。
                        </p>
                        <SourceProxySelect
                            value={proxy}
                            pool={proxyPool}
                            disabled={busy || conflict}
                            onChange={setProxy}
                        />
                        <SourceModelMapEditor
                            rows={modelRows}
                            idPrefix="source-management-model-map"
                            disabled={busy || conflict}
                            invalid={errorField === "modelMap"}
                            onChange={(rows) => {
                                setModelRows(rows);
                                if (errorField === "modelMap") {
                                    setErrorField("");
                                    setError("");
                                }
                            }}
                        />
                        <SourceMiddlewareSelect
                            value={middleware}
                            plugins={plugins}
                            disabled={busy || conflict}
                            onChange={setMiddleware}
                        />
                        <SourceHealthPolicyEditor
                            value={healthDraft}
                            effectivePolicy={baseline.effectiveHealthPolicy}
                            disabled={busy || conflict}
                            invalid={errorField === "healthPolicy"}
                            onChange={(value) => {
                                setHealthDraft(value);
                                if (errorField === "healthPolicy") {
                                    setErrorField("");
                                    setError("");
                                }
                            }}
                        />
                        {renderFeedback()}
                        <div class="config-actions source-management-actions">
                            <button
                                type="button"
                                class="icon-button source-delete-link"
                                aria-label="删除渠道…"
                                title="删除渠道"
                                disabled={busy || conflict}
                                onClick={() => {
                                    setView("delete");
                                    setError("");
                                    setNotice("");
                                }}
                            >
                                <Icon name="trash" />
                                <span class="sr-only">删除渠道…</span>
                            </button>
                            <button
                                type="button"
                                class="text-button"
                                disabled={busy}
                                onClick={close}
                            >
                                取消
                            </button>
                            <button
                                type="submit"
                                class="primary-button"
                                disabled={busy || conflict}
                            >
                                {action === "save" ? "保存中…" : "保存修改"}
                            </button>
                        </div>
                    </form>
                )
                : (
                    <div class="source-delete-confirmation">
                        <p>
                            确定删除{" "}
                            <strong>{baseline.name || baseline.id}</strong>？
                        </p>
                        <p class="field-help">
                            此渠道的连接配置及密钥将被移除。其他渠道和源插件不受影响。
                        </p>
                        {renderFeedback()}
                        <div class="config-actions">
                            <button
                                ref={cancelDelete}
                                type="button"
                                class="secondary-button"
                                disabled={busy}
                                onClick={() => {
                                    setView("edit");
                                    setError("");
                                }}
                            >
                                返回编辑
                            </button>
                            <button
                                type="button"
                                class="primary-button source-delete-button"
                                disabled={busy || conflict}
                                onClick={() => void run("delete")}
                            >
                                {action === "delete" ? "删除中…" : "确认删除"}
                            </button>
                        </div>
                    </div>
                )}
        </dialog>
    );

    function renderFeedback() {
        return (
            <>
                {error && (
                    <p
                        id="source-management-error"
                        class="form-error"
                        role="alert"
                    >
                        {error}
                    </p>
                )}
                {conflict && (
                    <>
                        <p class="field-help">你的修改仍保留在本窗口中。</p>
                        <button
                            type="button"
                            class="secondary-button"
                            disabled={busy}
                            onClick={() => void run("reload")}
                        >
                            {action === "reload" ? "读取中…" : "读取最新信息"}
                        </button>
                    </>
                )}
                {notice && <p class="notice" role="status">{notice}</p>}
            </>
        );
    }
}

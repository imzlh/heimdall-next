/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import type { ProxyPoolView } from "@heimdall/admin-contracts/proxies.ts";
import { Icon } from "../shared/icons.tsx";
import {
    PROXY_IMPLEMENTATION_NOTE,
    type ProxyPoolEnvelope,
} from "../shared/proxy-presentation.ts";
import {
    AdminApiError,
    describeError,
    loadProxyPool,
    saveProxyPool,
} from "./api/admin.ts";
import { controlValue } from "./dom.ts";
import { Dropdown } from "./forms/dropdown.tsx";
import { randomUuid } from "./random-id.ts";
import {
    mergeProxyPoolDraft,
    type ProxyEntryDraft,
    proxyPoolDirty,
    proxyPoolDraft,
    proxyPoolInput,
} from "./proxy-pool-draft.ts";

const EMPTY_POOL: ProxyPoolView = { defaultProxyId: null, entries: [] };

export function ProxyPoolPanel({ initial, initialError = "", onChanged }: {
    readonly initial?: ProxyPoolEnvelope | null;
    readonly initialError?: string;
    readonly onChanged?: (pool: ProxyPoolView) => void;
}) {
    const [baseline, setBaseline] = useState(initial?.pool ?? EMPTY_POOL);
    const [draft, setDraft] = useState(() =>
        proxyPoolDraft(initial?.pool ?? EMPTY_POOL)
    );
    const [etag, setEtag] = useState(initial?.etag ?? "");
    const [loaded, setLoaded] = useState(Boolean(initial));
    const [action, setAction] = useState<"load" | "save" | "">(
        initial ? "" : "load",
    );
    const [expanded, setExpanded] = useState("");
    const [deleting, setDeleting] = useState("");
    const [conflict, setConflict] = useState(false);
    const [error, setError] = useState(initialError);
    const [notice, setNotice] = useState("");
    const pending = useRef(false);
    const mounted = useRef(true);
    const busy = Boolean(action);
    const dirty = proxyPoolDirty(baseline, draft);

    useEffect(() => {
        mounted.current = true;
        if (!initial) void reload(false);
        return () => {
            mounted.current = false;
        };
    }, []);

    async function reload(preserve: boolean) {
        if (pending.current) return;
        pending.current = true;
        setAction("load");
        setError("");
        setNotice("");
        try {
            const result = await loadProxyPool();
            if (!mounted.current) return;
            setDraft(
                preserve
                    ? mergeProxyPoolDraft(baseline, draft, result.pool)
                    : proxyPoolDraft(result.pool),
            );
            setBaseline(result.pool);
            setEtag(result.etag);
            setLoaded(true);
            setConflict(false);
            setDeleting("");
            onChanged?.(result.pool);
            if (preserve) {
                setNotice(
                    "已读取最新版本并保留你的修改，请核对代理及认证状态后保存。",
                );
            }
        } catch (cause) {
            if (mounted.current) {
                setError(`读取代理池失败：${describeError(cause)}`);
            }
        } finally {
            pending.current = false;
            if (mounted.current) setAction("");
        }
    }

    function edit(id: string, patch: Partial<ProxyEntryDraft>) {
        setDraft((current) => ({
            ...current,
            entries: current.entries.map((entry) =>
                entry.id === id ? { ...entry, ...patch } : entry
            ),
        }));
        setError("");
        setNotice("");
    }

    function toggle(entry: ProxyEntryDraft) {
        edit(entry.id, { enabled: !entry.enabled });
        if (entry.enabled && draft.defaultProxyId === entry.id) {
            setDraft((current) => ({ ...current, defaultProxyId: null }));
            setNotice("默认代理已停用，全局默认改为直连；保存后更新配置。");
        }
    }

    function remove(id: string) {
        setDraft((current) => ({
            defaultProxyId: current.defaultProxyId === id
                ? null
                : current.defaultProxyId,
            entries: current.entries.filter((entry) => entry.id !== id),
        }));
        setDeleting("");
        setNotice(
            draft.defaultProxyId === id
                ? "已从草稿移除默认代理，全局默认改为直连；保存后更新配置。"
                : "已从草稿移除代理。指定此代理的渠道将在保存后显示代理不可用。",
        );
    }

    async function save() {
        if (pending.current || !loaded || conflict) return;
        setError("");
        setNotice("");
        let input;
        try {
            input = proxyPoolInput(draft);
        } catch (cause) {
            setError(describeError(cause));
            return;
        }
        pending.current = true;
        setAction("save");
        try {
            const result = await saveProxyPool(input, etag);
            if (!mounted.current) return;
            setBaseline(result.pool);
            setDraft(proxyPoolDraft(result.pool));
            setEtag(result.etag);
            setDeleting("");
            onChanged?.(result.pool);
            setNotice("代理选择已保存。插件会在读取配置时获得最新选择。");
        } catch (cause) {
            if (!mounted.current) return;
            if (
                cause instanceof AdminApiError &&
                [409, 412, 428].includes(cause.status)
            ) {
                setConflict(true);
                setError(
                    "代理池已被其他操作修改。你的草稿仍在，请读取最新版本后核对保存。",
                );
            } else setError(`保存代理池失败：${describeError(cause)}`);
        } finally {
            pending.current = false;
            if (mounted.current) setAction("");
        }
    }

    return (
        <section
            class="panel config-panel proxy-pool-panel"
            aria-labelledby="proxy-pool-title"
            aria-busy={busy ? "true" : "false"}
        >
            <div class="panel-heading">
                <div>
                    <h2 id="proxy-pool-title">出站代理池</h2>
                    <p>{PROXY_IMPLEMENTATION_NOTE}</p>
                </div>
                <span class="status-chip chip-muted">
                    {draft.entries.length} 个代理
                </span>
            </div>
            {action === "load" && <p role="status">正在读取代理池…</p>}
            <form
                class="settings-form"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                }}
            >
                <fieldset
                    class="proxy-pool-fields"
                    disabled={busy || !loaded || conflict}
                >
                    <div class="proxy-default-field">
                        <span class="field-label">全局默认</span>
                        <Dropdown
                            value={draft.defaultProxyId ?? ""}
                            dataName="proxy-default"
                            options={[
                                { value: "", label: "直连" },
                                ...(draft.defaultProxyId &&
                                        !draft.entries.some((entry) =>
                                            entry.id === draft.defaultProxyId
                                        )
                                    ? [{
                                        value: draft.defaultProxyId,
                                        label: "原默认代理已移除，请重新选择",
                                        disabled: true,
                                    }]
                                    : []),
                                ...draft.entries.map((entry) => ({
                                    value: entry.id,
                                    label: `${entry.name || "未命名代理"}${
                                        entry.enabled ? "" : "（已停用）"
                                    }`,
                                    disabled: !entry.enabled,
                                })),
                            ]}
                            ariaLabel="全局默认"
                            onChange={(next) => {
                                setDraft((current) => ({
                                    ...current,
                                    defaultProxyId: next || null,
                                }));
                                setNotice("");
                            }}
                        />
                        <span class="field-help">
                            未单独指定代理的渠道继承此选择。
                        </span>
                    </div>
                    <div class="proxy-entry-list">
                        {draft.entries.map((entry) => (
                            <section
                                class={`proxy-entry${
                                    expanded === entry.id ? " is-expanded" : ""
                                }`}
                                key={entry.id}
                                data-proxy-id={entry.id}
                            >
                                <div class="proxy-entry-heading">
                                    <div class="proxy-entry-identity">
                                        <strong>
                                            {entry.name || "未命名代理"}
                                        </strong>
                                        <small>
                                            {entry.url || "填写代理地址"}
                                        </small>
                                    </div>
                                    <div class="proxy-entry-actions">
                                        {draft.defaultProxyId === entry.id && (
                                            <span class="status-chip chip-muted">
                                                默认
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            class="text-button"
                                            aria-pressed={entry.enabled
                                                ? "true"
                                                : "false"}
                                            onClick={() => toggle(entry)}
                                        >
                                            {entry.enabled
                                                ? "已启用"
                                                : "已停用"}
                                        </button>
                                        <button
                                            type="button"
                                            class="icon-button"
                                            title={expanded === entry.id
                                                ? "收起代理"
                                                : "编辑代理"}
                                            aria-label={`${
                                                expanded === entry.id
                                                    ? "收起"
                                                    : "编辑"
                                            } ${entry.name || "代理"}`}
                                            aria-expanded={expanded === entry.id
                                                ? "true"
                                                : "false"}
                                            onClick={() =>
                                                setExpanded(
                                                    expanded === entry.id
                                                        ? ""
                                                        : entry.id,
                                                )}
                                        >
                                            <Icon name="settings" />
                                        </button>
                                    </div>
                                </div>
                                {expanded === entry.id && (
                                    <div class="proxy-entry-editor">
                                        <div class="field-grid">
                                            <label>
                                                名称<input
                                                    name={`proxy-name-${entry.id}`}
                                                    maxLength={80}
                                                    required
                                                    value={entry.name}
                                                    onInput={(event) =>
                                                        edit(entry.id, {
                                                            name: controlValue(
                                                                event,
                                                            ),
                                                        })}
                                                />
                                            </label>
                                            <label>
                                                代理地址<input
                                                    name={`proxy-url-${entry.id}`}
                                                    type="url"
                                                    placeholder="http://127.0.0.1:7890"
                                                    maxLength={2048}
                                                    required
                                                    value={entry.url}
                                                    autoComplete="off"
                                                    spellCheck={false}
                                                    onInput={(event) =>
                                                        edit(entry.id, {
                                                            url: controlValue(
                                                                event,
                                                            ),
                                                        })}
                                                />
                                            </label>
                                            <div class="wide-field">
                                                <span class="field-label">
                                                    代理认证
                                                </span>
                                                <Dropdown
                                                    value={entry.authMode}
                                                    dataName={`proxy-auth-${entry.id}`}
                                                    ariaLabel={`代理认证 ${
                                                        entry.name || entry.id
                                                    }`}
                                                    options={[
                                                        {
                                                            value: "keep",
                                                            label: entry
                                                                    .authConfigured
                                                                ? "保留已保存认证"
                                                                : "不设置认证",
                                                        },
                                                        {
                                                            value: "replace",
                                                            label: "填写新认证",
                                                        },
                                                        ...(entry
                                                                .authConfigured
                                                            ? [{
                                                                value: "clear",
                                                                label:
                                                                    "清除已保存认证",
                                                            }]
                                                            : []),
                                                    ]}
                                                    onChange={(mode) =>
                                                        edit(entry.id, {
                                                            authMode:
                                                                mode as ProxyEntryDraft[
                                                                    "authMode"
                                                                ],
                                                            username: "",
                                                            password: "",
                                                        })}
                                                />
                                            </div>
                                            {entry.authMode === "replace" && (
                                                <>
                                                    <label>
                                                        用户名<input
                                                            name={`proxy-user-${entry.id}`}
                                                            autoComplete="off"
                                                            maxLength={256}
                                                            value={entry
                                                                .username}
                                                            onInput={(event) =>
                                                                edit(entry.id, {
                                                                    username:
                                                                        controlValue(
                                                                            event,
                                                                        ),
                                                                })}
                                                        />
                                                    </label>
                                                    <label>
                                                        密码<input
                                                            name={`proxy-password-${entry.id}`}
                                                            type="password"
                                                            autoComplete="new-password"
                                                            maxLength={1024}
                                                            value={entry
                                                                .password}
                                                            onInput={(event) =>
                                                                edit(entry.id, {
                                                                    password:
                                                                        controlValue(
                                                                            event,
                                                                        ),
                                                                })}
                                                        />
                                                    </label>
                                                </>
                                            )}
                                        </div>
                                        <p class="field-help">
                                            {entry.authMode === "clear"
                                                ? "保存时清除该代理的认证。"
                                                : entry.authMode === "replace"
                                                ? "认证只写入，不会回显。密码可以留空。"
                                                : "认证不会回显，不填写新认证则保留现有配置。"}
                                        </p>
                                        <div class="proxy-entry-remove">
                                            {deleting === entry.id
                                                ? (
                                                    <>
                                                        <span>
                                                            确认移除这个代理？指定它的渠道将显示代理不可用。
                                                        </span>
                                                        <button
                                                            type="button"
                                                            class="text-button"
                                                            onClick={() =>
                                                                setDeleting("")}
                                                        >
                                                            保留代理
                                                        </button>
                                                        <button
                                                            type="button"
                                                            class="text-button danger-action"
                                                            onClick={() =>
                                                                remove(
                                                                    entry.id,
                                                                )}
                                                        >
                                                            确认移除
                                                        </button>
                                                    </>
                                                )
                                                : (
                                                    <button
                                                        type="button"
                                                        class="text-button danger-action"
                                                        onClick={() =>
                                                            setDeleting(
                                                                entry.id,
                                                            )}
                                                    >
                                                        <Icon
                                                            name="trash"
                                                            size={16}
                                                        />移除代理
                                                    </button>
                                                )}
                                        </div>
                                    </div>
                                )}
                            </section>
                        ))}
                    </div>
                    {!draft.entries.length && (
                        <p class="empty-state">
                            尚未添加代理。全局默认使用直连，也可以为渠道单独选择代理。
                        </p>
                    )}
                    <button
                        type="button"
                        class="secondary-button"
                        disabled={draft.entries.length >= 64}
                        onClick={() => {
                            const id = randomUuid();
                            setDraft((current) => ({
                                ...current,
                                entries: [...current.entries, {
                                    id,
                                    name: "",
                                    url: "",
                                    enabled: true,
                                    authConfigured: false,
                                    authMode: "keep",
                                    username: "",
                                    password: "",
                                }],
                            }));
                            setExpanded(id);
                            setNotice("");
                        }}
                    >
                        <Icon name="plus" size={16} />添加代理
                    </button>
                </fieldset>
                {error && <p class="form-error" role="alert">{error}</p>}
                {notice && <p class="notice" role="status">{notice}</p>}
                <div class="config-actions">
                    <button
                        type="submit"
                        class="primary-button"
                        disabled={busy || !loaded || conflict || !dirty}
                    >
                        {action === "save" ? "保存中…" : "保存代理池"}
                    </button>
                    <button
                        type="button"
                        class="text-button"
                        disabled={busy}
                        onClick={() => void reload(loaded)}
                    >
                        <Icon name="refresh" size={16} />
                        {conflict ? "读取最新版本，保留草稿" : "刷新代理池"}
                    </button>
                    {dirty && <span>有未保存的更改</span>}
                </div>
            </form>
        </section>
    );
}

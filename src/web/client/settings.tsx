/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useState } from "hono/jsx/dom";
import { controlValue } from "./dom.ts";
import { Icon } from "../shared/icons.tsx";
import {
    AdminApiError,
    describeError,
    loadRuntimeSettings,
    type RuntimeSettingsEnvelope,
    saveRuntimeSettings,
} from "./api/admin.ts";

export function RuntimeSettingsPanel({ onClose, initial, initialError = "" }: {
    onClose?: () => void;
    initial?: RuntimeSettingsEnvelope | null;
    initialError?: string;
}) {
    const [loading, setLoading] = useState(!initial);
    const [loaded, setLoaded] = useState(Boolean(initial));
    const [saving, setSaving] = useState(false);
    const [reload, setReload] = useState(0);
    const [conflict, setConflict] = useState(false);
    const [error, setError] = useState(initialError);
    const [message, setMessage] = useState("");
    const [etag, setEtag] = useState(initial?.etag ?? "");
    const [limit, setLimit] = useState(
        initial ? String(initial.settings.limitPerMinute) : "",
    );
    const [interval, setInterval] = useState(
        initial ? String(initial.settings.probeIntervalMs) : "",
    );
    const [proxyKey, setProxyKey] = useState("");
    const [keyConfigured, setKeyConfigured] = useState(
        initial?.settings.proxyKeyConfigured ?? false,
    );
    const [baseline, setBaseline] = useState({ limit, interval });
    const busy = loading || saving;
    const dirty = limit !== baseline.limit || interval !== baseline.interval ||
        proxyKey.length > 0;

    function applySettings(result: RuntimeSettingsEnvelope) {
        const next = {
            limit: String(result.settings.limitPerMinute),
            interval: String(result.settings.probeIntervalMs),
        };
        setEtag(result.etag);
        setLimit(next.limit);
        setInterval(next.interval);
        setBaseline(next);
        setProxyKey("");
        setKeyConfigured(result.settings.proxyKeyConfigured);
        setConflict(false);
        setLoaded(true);
    }

    useEffect(() => {
        if (initial && reload === 0) return;
        let cancelled = false;
        setLoading(true);
        setLoaded(false);
        setError("");
        setMessage("");
        loadRuntimeSettings().then((result) => {
            if (!cancelled) applySettings(result);
        }).catch((cause: unknown) => {
            if (!cancelled) {
                setError(`加载运行设置失败：${describeError(cause)}`);
            }
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => {
            cancelled = true;
        };
    }, [reload]);

    async function save(clearProxyKey = false) {
        if (busy || !loaded || conflict) return;
        setError("");
        setMessage("");
        const limitPerMinute = Number(limit);
        const probeIntervalMs = Number(interval);
        if (
            !limit.trim() || !Number.isSafeInteger(limitPerMinute) ||
            limitPerMinute < 0
        ) {
            setError("每分钟限额必须是非负整数");
            return;
        }
        if (
            !interval.trim() || !Number.isSafeInteger(probeIntervalMs) ||
            probeIntervalMs < 0
        ) {
            setError("探测间隔必须是非负整数");
            return;
        }
        setSaving(true);
        try {
            const patch: {
                limitPerMinute: number;
                probeIntervalMs: number;
                proxyKey?: string;
            } = { limitPerMinute, probeIntervalMs };
            if (clearProxyKey) patch.proxyKey = "";
            else if (proxyKey.trim()) patch.proxyKey = proxyKey;
            applySettings(await saveRuntimeSettings(patch, etag));
            setMessage(
                clearProxyKey ? "已清除网关访问密钥" : "已保存，立即生效",
            );
        } catch (cause) {
            if (
                cause instanceof AdminApiError &&
                [409, 412, 428].includes(cause.status)
            ) {
                setConflict(true);
                setError(
                    "运行设置已发生变化，请重新加载最新设置后再编辑保存。",
                );
            } else {
                setError(`保存运行设置失败：${describeError(cause)}`);
            }
        } finally {
            setSaving(false);
        }
    }

    return (
        <section
            class="panel config-panel"
            aria-labelledby="runtime-settings-title"
        >
            <div class="panel-heading">
                <div>
                    <h2 id="runtime-settings-title">运行设置</h2>
                    <p>
                        限额、探测间隔和网关访问密钥立即生效。密钥只写入，不会回显。
                    </p>
                </div>
                {onClose && (
                    <button
                        class="icon-button"
                        type="button"
                        aria-label="关闭"
                        title="返回总览"
                        onClick={onClose}
                        disabled={saving}
                    >
                        <Icon name="close" />
                    </button>
                )}
            </div>
            {loading && <p role="status">正在加载运行设置…</p>}
            <form
                class="settings-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                }}
            >
                <div class="field-grid">
                    <label>
                        每分钟限额
                        <input
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            required
                            value={limit}
                            disabled={busy || !loaded || conflict}
                            onInput={(event) => setLimit(controlValue(event))}
                        />
                    </label>
                    <label>
                        探测间隔（毫秒）
                        <input
                            type="number"
                            min="0"
                            step="1"
                            inputMode="numeric"
                            required
                            value={interval}
                            disabled={busy || !loaded || conflict}
                            onInput={(event) =>
                                setInterval(controlValue(event))}
                        />
                    </label>
                    <label class="wide-field">
                        网关访问密钥
                        <input
                            type="password"
                            autoComplete="new-password"
                            value={proxyKey}
                            placeholder={keyConfigured
                                ? "已配置，留空则保留"
                                : "未配置"}
                            disabled={busy || !loaded || conflict}
                            onInput={(event) =>
                                setProxyKey(controlValue(event))}
                        />
                    </label>
                </div>
                <div class="config-actions">
                    <button
                        class="primary-button"
                        type="submit"
                        disabled={busy || !loaded || conflict}
                    >
                        {saving ? "保存中…" : "保存设置"}
                    </button>
                    <button
                        class="text-button"
                        type="button"
                        disabled={busy || !loaded || conflict || !keyConfigured}
                        onClick={() => void save(true)}
                    >
                        清除网关访问密钥
                    </button>
                    <button
                        class={dirty ? "text-button" : "icon-button"}
                        type="button"
                        aria-label={dirty ? "重新加载（丢弃更改）" : "重新加载"}
                        title={dirty ? "重新加载（丢弃更改）" : "重新加载设置"}
                        disabled={busy}
                        onClick={() => setReload((value) => value + 1)}
                    >
                        <Icon name="refresh" />
                        {dirty && "重新加载（丢弃更改）"}
                    </button>
                    {loaded && dirty && <span>有未保存的更改</span>}
                </div>
                {error && <p class="form-error" role="alert">{error}</p>}
                {message && !dirty && (
                    <p class="form-success" role="status">{message}</p>
                )}
            </form>
        </section>
    );
}

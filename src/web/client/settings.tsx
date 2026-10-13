/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import { controlValue } from "./dom.ts";
import { GatewayKeyField } from "./gateway-key.tsx";
import { gatewayKeyPatch } from "./gateway-key-draft.ts";
import { Icon } from "../shared/icons.tsx";
import { MaintenanceStatus } from "../shared/maintenance-status.tsx";
import { SettingsCard } from "../shared/settings-card.tsx";
import {
    ASSET_RETENTION_NOTE,
    readRetentionDays,
    RETENTION_MAX_DAYS,
} from "../shared/retention-settings.ts";
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
    const [titleModel, setTitleModel] = useState(
        initial ? initial.settings.titleModel : "",
    );
    const [requestRetention, setRequestRetention] = useState(
        String(initial?.settings.requestRetentionDays ?? 0),
    );
    const [chatRetention, setChatRetention] = useState(
        String(initial?.settings.chatRetentionDays ?? 0),
    );
    const [maintenance, setMaintenance] = useState(initial?.maintenance);
    const [proxyKey, setProxyKey] = useState("");
    const [clearProxyKey, setClearProxyKey] = useState(false);
    const [keyConfigured, setKeyConfigured] = useState(
        initial?.settings.proxyKeyConfigured ?? false,
    );
    const [baseline, setBaseline] = useState({
        limit,
        interval,
        titleModel,
        requestRetention,
        chatRetention,
    });
    const pending = useRef(false);
    const mounted = useRef(true);
    const busy = loading || saving;
    const dirty = limit !== baseline.limit || interval !== baseline.interval ||
        titleModel !== baseline.titleModel || proxyKey.trim().length > 0 ||
        requestRetention !== baseline.requestRetention ||
        chatRetention !== baseline.chatRetention ||
        clearProxyKey;

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    function applySettings(result: RuntimeSettingsEnvelope) {
        const next = {
            limit: String(result.settings.limitPerMinute),
            interval: String(result.settings.probeIntervalMs),
            titleModel: result.settings.titleModel,
            requestRetention: String(result.settings.requestRetentionDays ?? 0),
            chatRetention: String(result.settings.chatRetentionDays ?? 0),
        };
        setEtag(result.etag);
        setLimit(next.limit);
        setInterval(next.interval);
        setTitleModel(next.titleModel);
        setRequestRetention(next.requestRetention);
        setChatRetention(next.chatRetention);
        setMaintenance(result.maintenance);
        setBaseline(next);
        setProxyKey("");
        setClearProxyKey(false);
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

    async function save() {
        if (pending.current || busy || !loaded || conflict) return;
        setError("");
        setMessage("");
        const limitPerMinute = Number(limit);
        const probeIntervalMs = Number(interval);
        const requestRetentionDays = readRetentionDays(
            Number(requestRetention),
        );
        const chatRetentionDays = readRetentionDays(Number(chatRetention));
        if (
            !limit.trim() || !Number.isSafeInteger(limitPerMinute) ||
            limitPerMinute < 0 || limitPerMinute > 100_000
        ) {
            setError("每分钟限额必须是 0 到 100000 的整数");
            return;
        }
        if (
            !interval.trim() || !Number.isSafeInteger(probeIntervalMs) ||
            probeIntervalMs < 0 || probeIntervalMs > 86_400_000
        ) {
            setError("探测间隔必须是 0 到 86400000 的整数");
            return;
        }
        if (!requestRetention.trim() || requestRetentionDays === undefined) {
            setError("请求记录保留天数必须是 0 到 3650 的整数，0 表示永久保留");
            return;
        }
        if (!chatRetention.trim() || chatRetentionDays === undefined) {
            setError("对话保留天数必须是 0 到 3650 的整数，0 表示永久保留");
            return;
        }
        pending.current = true;
        setSaving(true);
        try {
            const patch: {
                limitPerMinute: number;
                probeIntervalMs: number;
                proxyKey?: string;
                titleModel?: string;
                requestRetentionDays?: number;
                chatRetentionDays?: number;
            } = {
                limitPerMinute,
                probeIntervalMs,
                ...gatewayKeyPatch(proxyKey, clearProxyKey),
            };
            if (titleModel.trim() !== baseline.titleModel) {
                patch.titleModel = titleModel.trim();
            }
            if (requestRetention !== baseline.requestRetention) {
                patch.requestRetentionDays = requestRetentionDays;
            }
            if (chatRetention !== baseline.chatRetention) {
                patch.chatRetentionDays = chatRetentionDays;
            }
            const result = await saveRuntimeSettings(patch, etag);
            if (!mounted.current) return;
            applySettings(result);
            setMessage(
                clearProxyKey ? "已清除网关访问密钥" : "已保存，立即生效",
            );
        } catch (cause) {
            if (!mounted.current) return;
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
            pending.current = false;
            if (mounted.current) setSaving(false);
        }
    }

    return (
        <section
            class="runtime-settings-panel"
            aria-labelledby="runtime-settings-title"
        >
            <div class={onClose ? "panel-heading" : "sr-only"}>
                <h2 id="runtime-settings-title">运行设置</h2>
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
                class="settings-form runtime-settings-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save();
                }}
            >
                <div class="settings-grid">
                    <SettingsCard
                        id="runtime-behavior-title"
                        title="运行与对话"
                        description="管理请求频率、健康探测和标题生成。"
                        icon="gauge"
                    >
                        <div class="field-grid">
                            <label>
                                每分钟限额
                                <input
                                    type="number"
                                    min="0"
                                    max="100000"
                                    step="1"
                                    inputMode="numeric"
                                    required
                                    value={limit}
                                    disabled={busy || !loaded || conflict}
                                    onInput={(event) =>
                                        setLimit(controlValue(event))}
                                />
                                <small class="field-help">
                                    设为 0 则不限制请求频率。
                                </small>
                            </label>
                            <label>
                                探测间隔（毫秒）
                                <input
                                    type="number"
                                    min="0"
                                    max="86400000"
                                    step="1"
                                    inputMode="numeric"
                                    required
                                    value={interval}
                                    disabled={busy || !loaded || conflict}
                                    onInput={(event) =>
                                        setInterval(controlValue(event))}
                                />
                                <small class="field-help">
                                    设为 0 则关闭定时探测。
                                </small>
                            </label>
                            <label class="wide-field">
                                对话标题模型
                                <input
                                    type="text"
                                    value={titleModel}
                                    placeholder="默认使用对话所选模型"
                                    disabled={busy || !loaded || conflict}
                                    onInput={(event) =>
                                        setTitleModel(controlValue(event))}
                                />
                                <small class="field-help">
                                    留空时，使用当前对话的模型自动生成标题。
                                </small>
                            </label>
                        </div>
                    </SettingsCard>
                    <SettingsCard
                        id="runtime-security-title"
                        title="访问安全"
                        description="通过访问密钥保护网关的模型接口。"
                        icon="key"
                    >
                        <GatewayKeyField
                            value={proxyKey}
                            configured={keyConfigured}
                            clearRequested={clearProxyKey}
                            disabled={busy || !loaded || conflict}
                            onChange={(value, clear) => {
                                setProxyKey(value);
                                setClearProxyKey(clear);
                            }}
                        />
                    </SettingsCard>
                    <SettingsCard
                        id="runtime-retention-title"
                        title="数据保留"
                        description="设置请求记录与对话历史的保留时长。"
                        icon="logs"
                    >
                        <fieldset
                            class="retention-settings"
                            disabled={busy || !loaded || conflict}
                        >
                            <legend class="sr-only">数据保留</legend>
                            <p class="field-help" id="retention-policy-help">
                                按天保留历史，0
                                表示永久保留。缩短天数后，过期数据将在下次自动清理时删除。
                            </p>
                            <div class="field-grid">
                                <label>
                                    请求记录保留（天）
                                    <input
                                        name="requestRetentionDays"
                                        type="number"
                                        min="0"
                                        max={RETENTION_MAX_DAYS}
                                        step="1"
                                        inputMode="numeric"
                                        required
                                        value={requestRetention}
                                        aria-describedby="retention-policy-help request-retention-help"
                                        onInput={(event) =>
                                            setRequestRetention(
                                                controlValue(event),
                                            )}
                                    />
                                    <small
                                        id="request-retention-help"
                                        class="field-help"
                                    >
                                        清理过期请求记录；正在处理的请求会保留。
                                    </small>
                                </label>
                                <label>
                                    对话保留（天）
                                    <input
                                        name="chatRetentionDays"
                                        type="number"
                                        min="0"
                                        max={RETENTION_MAX_DAYS}
                                        step="1"
                                        inputMode="numeric"
                                        required
                                        value={chatRetention}
                                        aria-describedby="retention-policy-help chat-retention-help"
                                        onInput={(event) =>
                                            setChatRetention(
                                                controlValue(event),
                                            )}
                                    />
                                    <small
                                        id="chat-retention-help"
                                        class="field-help"
                                    >
                                        按最后活动时间计算；正在生成的对话会保留。
                                    </small>
                                </label>
                            </div>
                            <p class="field-help">{ASSET_RETENTION_NOTE}</p>
                        </fieldset>
                    </SettingsCard>
                    <div class="settings-card settings-maintenance-card">
                        <MaintenanceStatus status={maintenance} />
                    </div>
                </div>
                <div class="runtime-settings-footer">
                    <div class="runtime-settings-feedback" aria-live="polite">
                        {error && <p class="form-error" role="alert">{error}
                        </p>}
                        {message && !dirty && (
                            <p class="form-success" role="status">{message}</p>
                        )}
                        {!error && !(message && !dirty) && (
                            <p>
                                {loaded && dirty
                                    ? "有未保存的更改"
                                    : "设置保存后立即生效"}
                            </p>
                        )}
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
                            class={dirty ? "text-button" : "icon-button"}
                            type="button"
                            aria-label={dirty
                                ? "重新加载（丢弃更改）"
                                : "重新加载"}
                            title={dirty
                                ? "重新加载（丢弃更改）"
                                : "重新加载设置"}
                            disabled={busy}
                            onClick={() => setReload((value) => value + 1)}
                        >
                            <Icon name="refresh" />
                            {dirty && "重新加载（丢弃更改）"}
                        </button>
                    </div>
                </div>
            </form>
        </section>
    );
}

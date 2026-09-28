/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import { Icon } from "../shared/icons.tsx";
import { copyClipboardText } from "./clipboard.ts";
import { controlValue } from "./dom.ts";
import {
    GATEWAY_KEY_REVEAL_MS,
    generateGatewayKey,
} from "./gateway-key-draft.ts";

/** The only readable secret is this unsaved draft, never an existing server key. */
export function GatewayKeyField({
    value,
    configured,
    clearRequested,
    disabled,
    onChange,
}: {
    readonly value: string;
    readonly configured: boolean;
    readonly clearRequested: boolean;
    readonly disabled: boolean;
    readonly onChange: (value: string, clearRequested: boolean) => void;
}) {
    const [revealed, setRevealed] = useState(false);
    const [copied, setCopied] = useState(false);
    const [copying, setCopying] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const [error, setError] = useState("");
    const currentValue = useRef(value);
    const copyAttempt = useRef(0);
    const revealTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
        null,
    );
    const mounted = useRef(true);
    currentValue.current = value;

    useEffect(() => {
        mounted.current = true;
        const hide = () => setRevealed(false);
        const hideWhenAway = () => {
            if (document.visibilityState === "hidden") hide();
        };
        globalThis.addEventListener("pagehide", hide);
        globalThis.addEventListener("visibilitychange", hideWhenAway, true);
        return () => {
            mounted.current = false;
            copyAttempt.current = (copyAttempt.current ?? 0) + 1;
            currentValue.current = "";
            if (revealTimer.current !== null) {
                globalThis.clearTimeout(revealTimer.current);
                revealTimer.current = null;
            }
            globalThis.removeEventListener("pagehide", hide);
            globalThis.removeEventListener(
                "visibilitychange",
                hideWhenAway,
                true,
            );
        };
    }, []);

    useEffect(() => {
        copyAttempt.current = (copyAttempt.current ?? 0) + 1;
        setCopied(false);
        setCopying(false);
        setError("");
        setConfirmClear(false);
        if (!value) setRevealed(false);
    }, [value, clearRequested]);

    useEffect(() => {
        if (revealTimer.current !== null) {
            globalThis.clearTimeout(revealTimer.current);
            revealTimer.current = null;
        }
        if (!revealed || !value) return;
        const hide = () => setRevealed(false);
        const timer = globalThis.setTimeout(hide, GATEWAY_KEY_REVEAL_MS);
        revealTimer.current = timer;
        return () => {
            globalThis.clearTimeout(timer);
            if (revealTimer.current === timer) revealTimer.current = null;
        };
    }, [revealed, value]);

    function edit(next: string, clear = false) {
        currentValue.current = next;
        copyAttempt.current = (copyAttempt.current ?? 0) + 1;
        setCopied(false);
        setCopying(false);
        setError("");
        setConfirmClear(false);
        onChange(next, clear);
    }

    function generate() {
        try {
            edit(generateGatewayKey());
            setRevealed(true);
        } catch {
            setError("当前浏览器无法安全生成密钥，请手动填写。");
        }
    }

    async function copy() {
        const secret = (currentValue.current ?? "").trim();
        if (!secret || copying) return;
        const attempt = (copyAttempt.current ?? 0) + 1;
        copyAttempt.current = attempt;
        setCopying(true);
        setError("");
        try {
            await copyClipboardText(secret);
            if (mounted.current && copyAttempt.current === attempt) {
                setCopied(true);
            }
        } catch {
            if (mounted.current && copyAttempt.current === attempt) {
                setError("复制失败，请显示新密钥后手动选择复制。");
            }
        } finally {
            if (mounted.current && copyAttempt.current === attempt) {
                setCopying(false);
            }
        }
    }

    return (
        <div class="wide-field gateway-key-field">
            <div class="gateway-key-heading">
                <label htmlFor="runtime-gateway-key">网关访问密钥</label>
                <span class="gateway-key-status">
                    {clearRequested
                        ? "待清除"
                        : value.trim()
                        ? "新密钥待保存"
                        : configured
                        ? "已配置"
                        : "未配置"}
                </span>
            </div>
            <div class="secret-control">
                <input
                    id="runtime-gateway-key"
                    name="gateway-key-draft"
                    type={revealed && value ? "text" : "password"}
                    autoComplete="new-password"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={value}
                    placeholder={clearRequested
                        ? "保存设置后清除当前密钥"
                        : configured
                        ? "已配置，留空则保留"
                        : "输入新密钥或安全生成"}
                    aria-describedby="gateway-key-help"
                    disabled={disabled}
                    onInput={(event) => edit(controlValue(event))}
                />
                <button
                    class="icon-button"
                    type="button"
                    aria-label={revealed ? "隐藏新密钥" : "显示新密钥 60 秒"}
                    title={revealed ? "隐藏新密钥" : "显示新密钥 60 秒"}
                    aria-pressed={revealed}
                    disabled={disabled || !value}
                    onClick={() => setRevealed(!revealed)}
                >
                    <Icon name={revealed ? "eye-off" : "eye"} />
                </button>
            </div>
            <p id="gateway-key-help" class="gateway-key-help">
                {clearRequested
                    ? "保存设置后，网关将不再要求访问密钥。"
                    : value.trim()
                    ? "请在保存前复制新密钥；保存后无法再次查看。明文显示 60 秒后自动遮蔽。"
                    : configured
                    ? "已有密钥仅保存在服务端。填写或生成新密钥，会在保存后替换当前密钥。"
                    : "保护网关请求；使用密钥的客户端通过 Bearer 认证访问。"}
            </p>
            <div class="gateway-key-actions">
                <button
                    class="secondary-button"
                    type="button"
                    disabled={disabled}
                    onClick={generate}
                >
                    <Icon name="key" />
                    {value ? "重新生成" : "生成安全密钥"}
                </button>
                {value.trim() && (
                    <>
                        <button
                            class="secondary-button"
                            type="button"
                            disabled={disabled || copying}
                            onClick={() => void copy()}
                        >
                            <Icon name={copied ? "check" : "copy"} />
                            {copying
                                ? "复制中…"
                                : copied
                                ? "已复制新密钥"
                                : "复制新密钥"}
                        </button>
                        <button
                            class="text-button"
                            type="button"
                            disabled={disabled}
                            onClick={() => edit("")}
                        >
                            撤销新密钥
                        </button>
                    </>
                )}
                {configured && !clearRequested && !confirmClear && (
                    <button
                        class="text-button"
                        type="button"
                        disabled={disabled}
                        onClick={() => setConfirmClear(true)}
                    >
                        清除已有密钥
                    </button>
                )}
                {clearRequested && (
                    <button
                        class="text-button"
                        type="button"
                        disabled={disabled}
                        onClick={() => edit("")}
                    >
                        保留已有密钥
                    </button>
                )}
            </div>
            {confirmClear && (
                <div
                    class="gateway-key-confirm"
                    role="group"
                    aria-label="确认清除网关密钥"
                >
                    <p>
                        清除后，网关将不再要求此访问密钥。确认清除后仍需保存设置。
                    </p>
                    <div class="gateway-key-actions">
                        <button
                            class="secondary-button"
                            type="button"
                            autoFocus
                            disabled={disabled}
                            onClick={() => setConfirmClear(false)}
                        >
                            保留密钥
                        </button>
                        <button
                            class="text-button gateway-key-remove"
                            type="button"
                            disabled={disabled}
                            onClick={() => edit("", true)}
                        >
                            确认清除
                        </button>
                    </div>
                </div>
            )}
            {copied && (
                <p class="form-success" role="status">
                    新密钥已复制，请妥善保存。
                </p>
            )}
            {error && <p class="form-error" role="alert">{error}</p>}
        </div>
    );
}

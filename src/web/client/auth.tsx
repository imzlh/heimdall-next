/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx/dom */
import { useState } from "hono/jsx/dom";
import { controlValue } from "./dom.ts";
import { Icon } from "../shared/icons.tsx";

interface AuthPanelProps {
    busy: boolean;
    error: string;
    onConnect: (token: string) => Promise<void>;
    onClose?: () => void;
}

export function AuthPanel({ busy, error, onConnect, onClose }: AuthPanelProps) {
    const [token, setToken] = useState("");
    return (
        <section class="panel auth-panel" aria-labelledby="auth-title">
            <div class="panel-heading">
                <div>
                    <h2 id="auth-title">连接管理端</h2>
                    <p>输入管理令牌以查看和修改当前实例。</p>
                </div>
                {onClose && (
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="关闭"
                        title="关闭"
                        disabled={busy}
                        onClick={onClose}
                    >
                        <Icon name="close" />
                    </button>
                )}
            </div>
            <form
                class="auth-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    void onConnect(token);
                }}
            >
                <label>
                    管理令牌<input
                        type="password"
                        autoComplete="current-password"
                        value={token}
                        disabled={busy}
                        placeholder="Bearer token"
                        onInput={(event) => setToken(controlValue(event))}
                    />
                </label>
                <button type="submit" class="primary-button" disabled={busy}>
                    {busy ? "连接中…" : "连接"}
                </button>
            </form>
            {error && <p class="form-error" role="alert">{error}</p>}
        </section>
    );
}

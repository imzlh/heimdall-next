/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import {
    flushSync,
    render,
    useLayoutEffect,
    useRef,
    useState,
} from "hono/jsx/dom";
import {
    parsePresetUiAction,
    parsePresetUiContext,
    parsePresetUiFeedback,
    PRESET_UI_ACTION_EVENT,
    PRESET_UI_FEEDBACK_EVENT,
    type PresetUiAction,
    type PresetUiContext,
    type PresetUiFeedback,
} from "@heimdall/admin-contracts/preset-ui.ts";
import {
    AuthorizationError,
    type AuthorizationSession,
    type AuthorizedAccount,
    exchangeAuthorization,
    startAuthorization,
    validateAuthorizationCallback,
} from "./browser-auth.ts";
import { CHATHUB_PRESET_ID, CHATHUB_SOURCE_PLUGIN_ID } from "./identity.ts";

/** The host owns navigation and persistence; this module owns only this form. */
export function mount(
    element: HTMLElement,
    input: PresetUiContext,
): () => void {
    const context = parsePresetUiContext(input);
    if (
        context.presetId !== CHATHUB_PRESET_ID ||
        context.sourcePluginId !== CHATHUB_SOURCE_PLUGIN_ID
    ) throw new TypeError("ChatHub preset identity does not match its source");
    let unmount: (() => void) | undefined;
    let disposed = false;
    function Root() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active
            ? <ChatHubSetup element={element} context={context} />
            : null;
    }
    render(<Root />, element);
    return () => {
        if (disposed) return;
        disposed = true;
        flushSync(() => unmount?.());
        unmount = undefined;
    };
}

type Phase = "idle" | "starting" | "awaiting" | "exchanging" | "authorized";

function ChatHubSetup({ element, context }: {
    element: HTMLElement;
    context: PresetUiContext;
}) {
    const [phase, setPhase] = useState<Phase>("idle");
    const [session, setSession] = useState<AuthorizationSession | null>(null);
    const [callback, setCallback] = useState("");
    const [accountLabel, setAccountLabel] = useState("");
    const [models, setModels] = useState("");
    const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
    const [feedback, setFeedback] = useState<PresetUiFeedback | null>(null);
    // Credentials never become DOM attributes or stored drafts.
    const account = useRef<AuthorizedAccount | null>(null);
    const request = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const pending = useRef(false);
    const completed = useRef(false);
    const prefix = `chathub-${context.draft.id}`;
    const busy = phase === "starting" || phase === "exchanging" ||
        feedback?.status === "pending";
    const saved = feedback?.kind === "save" && feedback.status === "success";

    useLayoutEffect(() => {
        mounted.current = true;
        const receive = (event: Event) => {
            if (!(event instanceof CustomEvent) || event.target !== element) {
                return;
            }
            try {
                const next = parsePresetUiFeedback(event.detail);
                pending.current = next.status === "pending";
                setFeedback(next);
                setErrors(next.errors ?? {});
                if (next.kind === "save" && next.status === "success") {
                    completed.current = true;
                    account.current = null;
                    setCallback("");
                    setSession(null);
                }
            } catch {
                /* Ignore messages outside the public bridge contract. */
            }
        };
        element.addEventListener(PRESET_UI_FEEDBACK_EVENT, receive);
        return () => {
            mounted.current = false;
            request.current?.abort();
            request.current = null;
            account.current = null;
            element.removeEventListener(PRESET_UI_FEEDBACK_EVENT, receive);
        };
    }, [element]);

    async function authorize<T>(
        nextPhase: Phase,
        operation: (signal: AbortSignal) => Promise<T>,
        receive: (value: T) => void,
    ) {
        if (request.current || pending.current || completed.current) return;
        const controller = new AbortController();
        request.current = controller;
        setPhase(nextPhase);
        setErrors({});
        setFeedback(null);
        const timeout = setTimeout(() => controller.abort(), 25_000);
        try {
            const result = await operation(controller.signal);
            if (mounted.current && !controller.signal.aborted) receive(result);
        } catch (error) {
            if (!mounted.current) return;
            setPhase("idle");
            setSession(null);
            setCallback("");
            setErrors({
                _form: controller.signal.aborted
                    ? "授权请求超时，请重新准备授权。"
                    : error instanceof AuthorizationError
                    ? error.message
                    : "暂时无法完成授权，请稍后重试。",
            });
        } finally {
            clearTimeout(timeout);
            if (request.current === controller) request.current = null;
        }
    }

    function start() {
        if (request.current || pending.current || completed.current) return;
        account.current = null;
        setAccountLabel("");
        setCallback("");
        setSession(null);
        void authorize("starting", startAuthorization, (value) => {
            setSession(value);
            setPhase("awaiting");
        });
    }

    function exchange() {
        if (
            !session || request.current || pending.current || completed.current
        ) return;
        let normalized: string;
        try {
            normalized = validateAuthorizationCallback(callback, session.state);
        } catch (error) {
            setErrors({ callback: (error as AuthorizationError).message });
            return;
        }
        const currentSession = session;
        // PKCE sessions are consumed by the server even when the exchange fails.
        setSession(null);
        setCallback("");
        void authorize(
            "exchanging",
            (signal) =>
                exchangeAuthorization(currentSession, normalized, signal),
            (value) => {
                account.current = value;
                setAccountLabel(value.email || "Microsoft 工作或学校账号");
                setPhase("authorized");
            },
        );
    }

    function submit(kind: PresetUiAction["kind"]) {
        if (request.current || pending.current || completed.current) return;
        const credentials = account.current;
        if (!credentials) {
            setErrors({ _form: "请先完成 Microsoft 账号授权。" });
            return;
        }
        const selectedModels = models.trim().split(/[\s,]+/).filter(Boolean);
        if (
            selectedModels.length > 100 ||
            selectedModels.some((model) => model.length > 256)
        ) {
            setErrors({
                models: "最多填写 100 个模型，每个模型名称不超过 256 个字符。",
            });
            return;
        }
        let action: PresetUiAction;
        try {
            action = parsePresetUiAction({
                kind,
                config: {
                    id: context.draft.id,
                    oid: credentials.oid,
                    tid: credentials.tid,
                    accessToken: credentials.accessToken,
                    ...(credentials.refreshToken
                        ? { refreshToken: credentials.refreshToken }
                        : {}),
                    ...(credentials.email
                        ? { accountEmail: credentials.email }
                        : {}),
                    expiresAt: credentials.expiresAt,
                    ...(selectedModels.length
                        ? { models: selectedModels }
                        : {}),
                },
            });
        } catch {
            setErrors({ _form: "授权配置过大，无法提交，请重新授权后重试。" });
            return;
        }
        pending.current = true;
        setErrors({});
        setFeedback({ kind, status: "pending" });
        element.dispatchEvent(
            new CustomEvent(PRESET_UI_ACTION_EVENT, { detail: action }),
        );
    }

    return (
        <form
            class="preset-auth source-preset-form"
            noValidate
            aria-busy={busy ? "true" : "false"}
            onSubmit={(event) => {
                event.preventDefault();
                if (phase === "awaiting") exchange();
                else submit("save");
            }}
        >
            <div class="source-flow-body">
                <div class="preset-auth-intro">
                    <span class="preset-auth-mark" aria-hidden="true">
                        <svg
                            viewBox="0 0 24 24"
                            width="24"
                            height="24"
                            fill="currentColor"
                        >
                            <path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z" />
                        </svg>
                    </span>
                    <div>
                        <h3>连接 Microsoft ChatHub</h3>
                        <p class="field-help">
                            授权工作或学校账号，即可使用渠道默认模型。
                        </p>
                    </div>
                </div>
                <div
                    class={`preset-auth-panel${
                        phase === "authorized" ? " is-authorized" : ""
                    }`}
                >
                    {phase === "authorized"
                        ? (
                            <div class="preset-auth-account" role="status">
                                <span
                                    class="preset-auth-check"
                                    aria-hidden="true"
                                >
                                    ✓
                                </span>
                                <div>
                                    <strong>{accountLabel}</strong>
                                    <p class="field-help">
                                        已授权，可以保存渠道。
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    class="text-button"
                                    disabled={busy || saved}
                                    onClick={start}
                                >
                                    更换账号
                                </button>
                            </div>
                        )
                        : (
                            <>
                                <div class="preset-auth-heading">
                                    <div>
                                        <strong>
                                            {phase === "exchanging"
                                                ? "正在确认授权"
                                                : "Microsoft 账号授权"}
                                        </strong>
                                        <p class="field-help">
                                            登录完成后，将回调网址粘贴回这里。
                                        </p>
                                    </div>
                                    <span class="status-chip chip-muted">
                                        {phase === "awaiting"
                                            ? "等待登录"
                                            : phase === "starting" ||
                                                    phase === "exchanging"
                                            ? "处理中"
                                            : "未授权"}
                                    </span>
                                </div>
                                {phase === "idle" || phase === "starting"
                                    ? (
                                        <button
                                            type="button"
                                            class="secondary-button"
                                            disabled={busy}
                                            onClick={start}
                                        >
                                            {phase === "starting"
                                                ? "准备中…"
                                                : "准备 Microsoft 授权"}
                                        </button>
                                    )
                                    : null}
                                {session && (
                                    <div class="preset-auth-steps">
                                        <div class="preset-auth-step">
                                            <span
                                                class="preset-auth-step-number"
                                                aria-hidden="true"
                                            >
                                                1
                                            </span>
                                            <div>
                                                <a
                                                    class="secondary-button preset-auth-link"
                                                    href={session.authUrl}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    referrerPolicy="no-referrer"
                                                >
                                                    前往 Microsoft 登录{" "}
                                                    <span aria-hidden="true">
                                                        ↗
                                                    </span>
                                                </a>
                                                <p class="field-help">
                                                    在新窗口完成登录，本配置窗会保留。
                                                </p>
                                            </div>
                                        </div>
                                        <div class="preset-auth-step">
                                            <span
                                                class="preset-auth-step-number"
                                                aria-hidden="true"
                                            >
                                                2
                                            </span>
                                            <div class="schema-field">
                                                <label
                                                    for={`${prefix}-callback`}
                                                >
                                                    粘贴登录回调网址
                                                </label>
                                                <input
                                                    id={`${prefix}-callback`}
                                                    name="callback"
                                                    type="password"
                                                    autoComplete="off"
                                                    spellCheck={false}
                                                    maxLength={16_384}
                                                    value={callback}
                                                    placeholder="https://login.microsoftonline.com/…"
                                                    aria-invalid={errors
                                                            .callback
                                                        ? "true"
                                                        : undefined}
                                                    aria-describedby={`${prefix}-callback-help${
                                                        errors.callback
                                                            ? ` ${prefix}-callback-error`
                                                            : ""
                                                    }`}
                                                    onInput={(event) => {
                                                        setCallback(
                                                            (event
                                                                .currentTarget as HTMLInputElement)
                                                                .value,
                                                        );
                                                        setErrors({});
                                                    }}
                                                />
                                                <p
                                                    class="field-help"
                                                    id={`${prefix}-callback-help`}
                                                >
                                                    复制地址栏中包含
                                                    nativeclient?code=…
                                                    的完整网址。
                                                </p>
                                                {errors.callback && (
                                                    <p
                                                        class="field-error"
                                                        id={`${prefix}-callback-error`}
                                                        role="alert"
                                                    >
                                                        {errors.callback}
                                                    </p>
                                                )}
                                                <div class="preset-auth-inline-actions">
                                                    <button
                                                        type="button"
                                                        class="primary-button"
                                                        disabled={!callback
                                                            .trim()}
                                                        onClick={exchange}
                                                    >
                                                        完成授权
                                                    </button>
                                                    <button
                                                        type="button"
                                                        class="text-button"
                                                        onClick={start}
                                                    >
                                                        重新准备
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                {phase === "exchanging" && (
                                    <p
                                        class="preset-auth-progress"
                                        role="status"
                                    >
                                        <span
                                            class="preset-auth-spinner"
                                            aria-hidden="true"
                                        />正在换取账号授权，请稍候…
                                    </p>
                                )}
                            </>
                        )}
                </div>
                <details class="preset-auth-options">
                    <summary>
                        模型选项 <span class="field-help">可选</span>
                    </summary>
                    <div class="schema-field">
                        <label for={`${prefix}-models`}>发布的模型</label>
                        <input
                            id={`${prefix}-models`}
                            name="models"
                            value={models}
                            maxLength={25_600}
                            placeholder="留空使用渠道默认模型"
                            disabled={busy || saved}
                            aria-invalid={errors.models ? "true" : undefined}
                            aria-describedby={`${prefix}-models-help${
                                errors.models ? ` ${prefix}-models-error` : ""
                            }`}
                            onInput={(event) => {
                                setModels(
                                    (event.currentTarget as HTMLInputElement)
                                        .value,
                                );
                                setErrors({});
                                setFeedback(null);
                            }}
                        />
                        <p class="field-help" id={`${prefix}-models-help`}>
                            需要覆盖默认值时填写模型名称，多个模型用逗号分隔。
                        </p>
                        {errors.models && (
                            <p
                                class="field-error"
                                id={`${prefix}-models-error`}
                                role="alert"
                            >
                                {errors.models}
                            </p>
                        )}
                    </div>
                </details>
                {errors._form && (
                    <p class="form-error" role="alert">{errors._form}</p>
                )}
                {feedback?.status === "success" && (
                    <p class="form-success" role="status">
                        {saved
                            ? "渠道已创建。"
                            : "配置校验通过，可以保存渠道。"}
                    </p>
                )}
            </div>
            <div class="config-actions source-flow-footer source-preset-actions">
                <button
                    type="button"
                    class="secondary-button"
                    disabled={phase !== "authorized" || busy || saved}
                    onClick={() => submit("preview")}
                >
                    {busy && feedback?.kind === "preview"
                        ? "校验中…"
                        : "校验配置"}
                </button>
                <button
                    type="submit"
                    class="primary-button"
                    disabled={phase !== "authorized" || busy || saved}
                >
                    {busy && feedback?.kind === "save" ? "保存中…" : "保存渠道"}
                </button>
            </div>
        </form>
    );
}

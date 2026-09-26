/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { Icon } from "@heimdall/ui/icons";
import {
    flushSync,
    render,
    useEffect,
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
import { validateNewApiPresetConfig } from "./schema.ts";

/** NewAPI renders inside the host dialog and requests actions through JSON events. */
export function mount(
    element: HTMLElement,
    input: PresetUiContext,
): () => void {
    const context = parsePresetUiContext(input);
    let unmount: (() => void) | undefined;
    let disposed = false;
    function Root() {
        const [active, setActive] = useState(true);
        unmount = () => setActive(false);
        return active
            ? <NewApiSetup element={element} context={context} />
            : null;
    }
    render(<Root />, element);
    return () => {
        if (disposed) return;
        disposed = true;
        // Updating the existing root runs hook cleanups; render(null, element)
        // would only replace its DOM children in Hono's browser renderer.
        flushSync(() => unmount?.());
        unmount = undefined;
    };
}

function NewApiSetup({ element, context }: {
    element: HTMLElement;
    context: PresetUiContext;
}) {
    const [baseUrl, setBaseUrl] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [visible, setVisible] = useState(false);
    const [feedback, setFeedback] = useState<PresetUiFeedback | null>(null);
    const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
    const form = useRef<HTMLFormElement | null>(null);
    const pending = useRef(false);
    const busy = feedback?.status === "pending";
    const saved = feedback?.kind === "save" && feedback.status === "success";
    const prefix = `newapi-${context.draft.id}`;

    useLayoutEffect(() => {
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
                    setApiKey("");
                    setVisible(false);
                }
            } catch {
                /* Ignore messages outside the public feedback contract. */
            }
        };
        element.addEventListener(PRESET_UI_FEEDBACK_EVENT, receive);
        return () =>
            element.removeEventListener(PRESET_UI_FEEDBACK_EVENT, receive);
    }, [element]);

    useEffect(() => {
        if (Object.keys(errors).length) {
            form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
        }
    }, [errors]);

    function submit(kind: PresetUiAction["kind"]) {
        if (pending.current || saved) return;
        setErrors({});
        setFeedback(null);
        let normalized;
        try {
            normalized = validateNewApiPresetConfig({
                id: context.draft.id,
                baseUrl,
                ...(apiKey.trim() ? { apiKey } : {}),
            });
        } catch {
            setErrors({
                baseUrl:
                    "请输入完整的 HTTP(S) 服务地址，不要包含账号、查询参数或片段。",
            });
            return;
        }
        let action: PresetUiAction;
        try {
            action = parsePresetUiAction({
                kind,
                config: {
                    id: context.draft.id,
                    baseUrl: normalized.baseUrl,
                    ...(normalized.apiKey ? { apiKey: normalized.apiKey } : {}),
                },
            });
        } catch {
            setErrors({ _form: "配置内容过长，请检查服务地址和访问令牌。" });
            return;
        }
        pending.current = true;
        setFeedback({ kind, status: "pending" });
        element.dispatchEvent(
            new CustomEvent(PRESET_UI_ACTION_EVENT, { detail: action }),
        );
    }

    const change = (update: () => void) => {
        update();
        setErrors({});
        setFeedback(null);
    };
    return (
        <form
            ref={form}
            noValidate
            class="newapi-setup source-preset-form"
            aria-busy={busy ? "true" : "false"}
            onSubmit={(event) => {
                event.preventDefault();
                submit("save");
            }}
        >
            <div class="source-flow-body">
                <div class="schema-form">
                    <div class="schema-field wide-field">
                        <label for={`${prefix}-url`}>
                            服务地址 <span class="field-required">必填</span>
                        </label>
                        <input
                            id={`${prefix}-url`}
                            name="baseUrl"
                            type="url"
                            inputMode="url"
                            autoComplete="url"
                            required
                            maxLength={2048}
                            value={baseUrl}
                            disabled={busy || saved}
                            placeholder="https://your-newapi.example/v1"
                            aria-invalid={errors.baseUrl ? "true" : undefined}
                            aria-describedby={`${prefix}-url-help${
                                errors.baseUrl ? ` ${prefix}-url-error` : ""
                            }`}
                            onInput={(event) =>
                                change(() =>
                                    setBaseUrl(
                                        (event
                                            .currentTarget as HTMLInputElement)
                                            .value,
                                    )
                                )}
                        />
                        <p class="field-help" id={`${prefix}-url-help`}>
                            使用 NewAPI 提供的 API 地址，通常以 /v1 结尾。
                        </p>
                        {errors.baseUrl && (
                            <p
                                class="field-error"
                                id={`${prefix}-url-error`}
                                role="alert"
                            >
                                {errors.baseUrl}
                            </p>
                        )}
                    </div>
                    <div class="schema-field wide-field">
                        <label for={`${prefix}-key`}>访问令牌</label>
                        <div class="secret-control">
                            <input
                                id={`${prefix}-key`}
                                name="apiKey"
                                type={visible ? "text" : "password"}
                                autoComplete="new-password"
                                maxLength={16_384}
                                value={apiKey}
                                disabled={busy || saved}
                                placeholder="输入 NewAPI 中创建的令牌"
                                aria-describedby={`${prefix}-key-help`}
                                onInput={(event) =>
                                    change(() =>
                                        setApiKey(
                                            (event
                                                .currentTarget as HTMLInputElement)
                                                .value,
                                        )
                                    )}
                            />
                            <button
                                type="button"
                                class="icon-button"
                                aria-controls={`${prefix}-key`}
                                aria-pressed={visible ? "true" : "false"}
                                aria-label="显示访问令牌"
                                title={visible
                                    ? "隐藏访问令牌"
                                    : "显示访问令牌"}
                                disabled={busy || saved}
                                onClick={() => setVisible((value) => !value)}
                            >
                                <Icon name={visible ? "eye-off" : "eye"} />
                            </button>
                        </div>
                        <p class="field-help" id={`${prefix}-key-help`}>
                            如服务允许免认证可留空。令牌不会写入浏览器草稿。
                        </p>
                    </div>
                </div>
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
                    disabled={busy || saved}
                    onClick={() => submit("preview")}
                >
                    {busy && feedback.kind === "preview"
                        ? "校验中…"
                        : "校验配置"}
                </button>
                <button
                    type="submit"
                    class="primary-button"
                    disabled={busy || saved}
                >
                    {busy && feedback.kind === "save" ? "保存中…" : "保存渠道"}
                </button>
            </div>
        </form>
    );
}

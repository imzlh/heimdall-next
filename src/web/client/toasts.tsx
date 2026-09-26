/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useCallback, useRef, useState } from "hono/jsx/dom";
import { Icon } from "../shared/icons.tsx";

/**
 * Bottom-right toast stack, following the original console: short-lived
 * confirmations, warnings that linger, and duplicate suppression so a
 * repeated action cannot stack identical messages.
 */
export type ToastTone = "ok" | "warn" | "info";

export interface ToastItem {
    readonly id: number;
    readonly tone: ToastTone;
    readonly message: string;
    closing: boolean;
}

const TOAST_DURATION: Record<ToastTone, number> = {
    ok: 1800,
    warn: 6000,
    info: 2500,
};
const DUPLICATE_WINDOW_MS = 3000;
const MAX_STACK = 4;

export function useToasts() {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const nextId = useRef(1);
    const recent = useRef({ message: "", at: 0 });
    const dismiss = useCallback((id: number) => {
        setToasts((list) =>
            list.map((toast) =>
                toast.id === id ? { ...toast, closing: true } : toast
            )
        );
    }, []);
    const remove = useCallback((id: number) => {
        setToasts((list) => list.filter((toast) => toast.id !== id));
    }, []);
    const push = useCallback((tone: ToastTone, message: string) => {
        if (!message) return;
        const now = Date.now();
        const recentToast = recent.current ?? { message: "", at: 0 };
        if (
            recentToast.message === message &&
            now - recentToast.at < DUPLICATE_WINDOW_MS
        ) return;
        recent.current = { message, at: now };
        const id = (nextId.current ?? 0) + 1;
        nextId.current = id;
        setToasts((list) => [
            ...list.slice(-(MAX_STACK - 1)),
            { id, tone, message, closing: false },
        ]);
        globalThis.setTimeout(
            () => dismiss(id),
            TOAST_DURATION[tone],
        );
    }, [dismiss]);
    return { toasts, push, dismiss, remove };
}

export function ToastStack(
    { toasts, dismiss, remove }: {
        toasts: readonly ToastItem[];
        dismiss: (id: number) => void;
        remove: (id: number) => void;
    },
) {
    if (!toasts.length) return null;
    return (
        <div class="console-toast-stack" role="status" aria-live="polite">
            {toasts.map((toast) => (
                <div
                    key={toast.id}
                    class={`console-toast toast-${toast.tone}${
                        toast.closing ? " is-closing" : ""
                    }`}
                    onAnimationEnd={(event) => {
                        if (
                            event.target === event.currentTarget &&
                            event.animationName === "console-toast-out"
                        ) remove(toast.id);
                    }}
                >
                    <span>{toast.message}</span>
                    <button
                        type="button"
                        class="icon-button"
                        aria-label="关闭通知"
                        title="关闭通知"
                        onClick={() => dismiss(toast.id)}
                    >
                        <Icon name="close" />
                    </button>
                </div>
            ))}
        </div>
    );
}

/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import type { Child } from "hono/jsx";
import { useEffect, useRef } from "hono/jsx/dom";
import { Icon } from "../shared/icons.tsx";

/** The native modal supplies focus containment; restore focus when it is dismissed. */
export function PluginDialog({ title, busy, onClose, children }: {
    title: string;
    busy: boolean;
    onClose: () => void;
    children: Child;
}) {
    const dialog = useRef<HTMLDialogElement | null>(null);
    const close = useRef<HTMLButtonElement | null>(null);
    useEffect(() => {
        const trigger = document.activeElement as HTMLElement | null;
        const element = dialog.current;
        if (element && !element.open) element.showModal();
        close.current?.focus();
        return () => {
            if (element?.open) element.close();
            if (trigger?.isConnected && !trigger.hasAttribute("disabled")) {
                trigger.focus();
            }
        };
    }, []);
    return (
        <dialog
            ref={dialog}
            class="source-dialog plugin-dialog"
            aria-labelledby="plugin-dialog-title"
            aria-busy={busy ? "true" : "false"}
            onCancel={(event: Event) => {
                event.preventDefault();
                if (!busy) onClose();
            }}
        >
            <header class="panel-heading">
                <h2 id="plugin-dialog-title">{title}</h2>
                <button
                    ref={close}
                    type="button"
                    class="icon-button"
                    disabled={busy}
                    aria-label="关闭插件操作"
                    onClick={onClose}
                >
                    <Icon name="close" />
                </button>
            </header>
            {children}
        </dialog>
    );
}

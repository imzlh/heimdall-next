/** Copy from a user action, including ordinary HTTP deployments. */
export async function copyChatText(text: string): Promise<void> {
    try {
        if (globalThis.navigator?.clipboard?.writeText) {
            await globalThis.navigator.clipboard.writeText(text);
            return;
        }
    } catch {
        // Clipboard permissions may reject even when the API exists.
    }

    const document = globalThis.document;
    if (!document?.body || typeof document.execCommand !== "function") {
        throw new Error("Clipboard is unavailable");
    }
    const active = document.activeElement as HTMLElement | null;
    const field = active as HTMLInputElement | HTMLTextAreaElement | null;
    const start = field?.selectionStart;
    const end = field?.selectionEnd;
    const direction = field?.selectionDirection;
    const selection = document.getSelection();
    const ranges: Range[] = [];
    if (selection) {
        for (let index = 0; index < selection.rangeCount; index++) {
            ranges.push(selection.getRangeAt(index).cloneRange());
        }
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.tabIndex = -1;
    textarea.style.cssText =
        "position:fixed;inset:0 auto auto 0;opacity:0;pointer-events:none;font-size:16px";
    try {
        document.body.appendChild(textarea);
        textarea.focus({ preventScroll: true });
        textarea.select();
        if (!document.execCommand("copy")) {
            throw new Error("Clipboard copy failed");
        }
    } finally {
        textarea.remove();
        try {
            if (active?.isConnected) active.focus({ preventScroll: true });
        } catch {
            // Losing the previous node must not hide a successful copy.
        }
        try {
            selection?.removeAllRanges();
            for (const range of ranges) selection?.addRange(range);
        } catch {
            // A browser can invalidate a range when focus changes.
        }
        try {
            if (
                field?.isConnected && typeof start === "number" &&
                typeof end === "number"
            ) {
                field.setSelectionRange(start, end, direction ?? undefined);
            }
        } catch {
            // Not every input type supports restoring a text selection.
        }
    }
}

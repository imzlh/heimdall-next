type ComposerKey = Pick<
    KeyboardEvent,
    "key" | "isComposing" | "keyCode" | "shiftKey" | "ctrlKey" | "metaKey"
>;

/** IME confirmation never sends; Shift, Ctrl and Cmd + Enter insert a newline. */
export function composerKeyAction(
    event: ComposerKey,
): "none" | "newline" | "send" {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) {
        return "none";
    }
    return event.shiftKey || event.ctrlKey || event.metaKey
        ? "newline"
        : "send";
}

/** Replace the selection, keeping the caret after the inserted newline. */
export function insertComposerNewline(
    value: string,
    start: number,
    end: number,
): { text: string; caret: number } {
    return {
        text: `${value.slice(0, start)}\n${value.slice(end)}`,
        caret: start + 1,
    };
}

const MIN_HEIGHT = 32;
const MAX_HEIGHT = 144;

/**
 * Measure with transitions suppressed, then animate from the current visual
 * height. This preserves an in-flight growth animation during rapid typing.
 */
export function resizeComposerInput(input: HTMLTextAreaElement): void {
    const previous = input.getBoundingClientRect().height || MIN_HEIGHT;
    const transition = input.style.transition;
    input.style.transition = "none";
    input.style.height = "auto";
    const measured = input.scrollHeight;
    input.style.height = `${previous}px`;
    // Commit the measuring reset without animating toward the intermediate auto.
    void input.offsetHeight;
    input.style.transition = transition;
    input.style.height = `${
        Math.max(MIN_HEIGHT, Math.min(measured, MAX_HEIGHT))
    }px`;
    input.style.overflowY = measured > MAX_HEIGHT ? "auto" : "hidden";
}

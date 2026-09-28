/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */

export interface SwitchProps {
    readonly checked: boolean;
    readonly onToggle: () => void;
    /** Visible text next to the track; omit for a track-only control. */
    readonly label?: string;
    readonly ariaLabel?: string;
    readonly describedBy?: string;
    readonly disabled?: boolean;
    readonly title?: string;
    readonly id?: string;
    readonly class?: string;
}

/**
 * Design-system switch that replaces native checkboxes in islands. The track
 * and knob reuse the source-state-toggle measurements so every boolean
 * control reads the same; a track-only switch stays labelable via `id`.
 */
export function Switch(
    {
        checked,
        onToggle,
        label,
        ariaLabel,
        describedBy,
        disabled,
        title,
        id,
        class: className,
    }: SwitchProps,
) {
    return (
        <button
            id={id}
            type="button"
            role="switch"
            aria-checked={checked ? "true" : "false"}
            aria-label={ariaLabel}
            aria-describedby={describedBy}
            title={title}
            disabled={disabled}
            class={`switch-control${className ? ` ${className}` : ""}`}
            onClick={onToggle}
        >
            <span class="switch-track" aria-hidden="true" />
            {label !== undefined && <span>{label}</span>}
        </button>
    );
}

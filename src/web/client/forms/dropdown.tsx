/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useEffect, useRef, useState } from "hono/jsx/dom";
import { Icon } from "../../shared/icons.tsx";

export interface DropdownOption {
    readonly value: string;
    readonly label: string;
    readonly disabled?: boolean;
}

/**
 * Styled listbox that replaces native <select> everywhere: trigger button,
 * floating menu, outside-click/Escape dismissal and arrow-key navigation.
 */
export function Dropdown(
    {
        value,
        options,
        onChange,
        placeholder = "请选择",
        ariaLabel,
        describedBy,
        disabled = false,
        id,
        dataName,
        class: className,
    }: {
        readonly value: string;
        readonly options: readonly DropdownOption[];
        readonly onChange: (value: string) => void;
        readonly placeholder?: string;
        readonly ariaLabel?: string;
        readonly describedBy?: string;
        readonly disabled?: boolean;
        readonly id?: string;
        /** Stable test hook rendered as data-dropdown on the trigger. */
        readonly dataName?: string;
        readonly class?: string;
    },
) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement | null>(null);
    const menu = useRef<HTMLDivElement | null>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    const selected = options.find((option) => option.value === value);
    const menuItems = () =>
        Array.from(
            menu.current?.querySelectorAll<HTMLButtonElement>(
                "button[data-value]",
            ) ?? [],
        ).filter((element) => !element.disabled);
    useEffect(() => {
        if (!open) return;
        let focused = false;
        for (const element of menuItems()) {
            if (element.getAttribute("data-value") === value) {
                element.focus();
                focused = true;
                break;
            }
        }
        if (!focused) menuItems()[0]?.focus();
        const onPointerDown = (event: PointerEvent) => {
            if (!root.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            const list = menuItems();
            const index = list.findIndex((element) =>
                element === document.activeElement
            );
            if (event.key === "Escape") {
                // Close the menu without closing a dialog that hosts it.
                event.preventDefault();
                setOpen(false);
                trigger.current?.focus();
            } else if (event.key === "Tab") {
                setOpen(false);
            } else if (
                event.key === "ArrowDown" || event.key === "ArrowUp"
            ) {
                event.preventDefault();
                const offset = event.key === "ArrowDown" ? 1 : -1;
                const target = index < 0
                    ? list[0]
                    : list[(index + offset + list.length) % list.length];
                (target ?? list[0])?.focus();
            }
        };
        document.addEventListener?.("pointerdown", onPointerDown);
        document.addEventListener?.("keydown", onKeyDown);
        return () => {
            document.removeEventListener?.("pointerdown", onPointerDown);
            document.removeEventListener?.("keydown", onKeyDown);
        };
    }, [open, value]);
    return (
        <div
            ref={root}
            class={`dropdown${open ? " is-open" : ""}${
                className ? ` ${className}` : ""
            }`}
        >
            <button
                ref={trigger}
                type="button"
                id={id}
                data-value={value}
                data-dropdown={dataName}
                class="dropdown-trigger"
                aria-haspopup="listbox"
                aria-expanded={open ? "true" : "false"}
                aria-label={ariaLabel}
                aria-describedby={describedBy}
                disabled={disabled}
                onClick={() => setOpen((current) => !current)}
                onKeyDown={(event: KeyboardEvent) => {
                    if (!open && event.key === "ArrowDown") {
                        event.preventDefault();
                        setOpen(true);
                    }
                }}
            >
                <span
                    class="dropdown-value"
                    data-empty={selected ? "false" : "true"}
                >
                    {selected ? selected.label : placeholder}
                </span>
                <Icon name="chevron-down" size={14} class="dropdown-chevron" />
            </button>
            {open && (
                <div ref={menu} class="dropdown-menu" role="listbox">
                    {options.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            role="option"
                            data-value={option.value}
                            aria-selected={option.value === value
                                ? "true"
                                : "false"}
                            disabled={option.disabled}
                            class={`dropdown-option${
                                option.value === value ? " is-selected" : ""
                            }`}
                            onClick={() => {
                                onChange(option.value);
                                setOpen(false);
                                trigger.current?.focus();
                            }}
                        >
                            <span class="dropdown-option-label">
                                {option.label}
                            </span>
                            {option.value === value && (
                                <Icon name="check" size={14} />
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

import { join } from "node:path";

/** Normal window bounds; enlarged windows should retain their restore bounds. */
export interface DesktopWindowState {
    readonly width: number;
    readonly height: number;
    readonly x?: number;
    readonly y?: number;
    readonly alwaysOnTop?: boolean;
}

export const DEFAULT_DESKTOP_WINDOW_STATE: DesktopWindowState = Object.freeze({
    width: 1280,
    height: 840,
});

function integerInRange(
    value: unknown,
    minimum: number,
    maximum: number,
): boolean {
    return typeof value === "number" && Number.isInteger(value) &&
        value >= minimum && value <= maximum;
}

/** Screen visibility is checked by the renderer, which knows the current display. */
export function sanitizeDesktopWindowState(value: unknown): DesktopWindowState {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ...DEFAULT_DESKTOP_WINDOW_STATE };
    }
    const candidate = value as Record<string, unknown>;
    if (
        !integerInRange(candidate.width, 640, 16_384) ||
        !integerInRange(candidate.height, 480, 16_384)
    ) return { ...DEFAULT_DESKTOP_WINDOW_STATE };

    const position = integerInRange(candidate.x, -100_000, 100_000) &&
            integerInRange(candidate.y, -100_000, 100_000)
        ? { x: candidate.x as number, y: candidate.y as number }
        : {};
    const pin = typeof candidate.alwaysOnTop === "boolean"
        ? { alwaysOnTop: candidate.alwaysOnTop }
        : {};
    return {
        width: candidate.width as number,
        height: candidate.height as number,
        ...position,
        ...pin,
    };
}

export async function loadDesktopWindowState(
    dataDirectory: string,
): Promise<DesktopWindowState> {
    try {
        const content = await Deno.readTextFile(
            join(dataDirectory, "desktop-window.json"),
        );
        // Preferences are a few hundred bytes. Reject accidental large files.
        if (content.length > 4096) return { ...DEFAULT_DESKTOP_WINDOW_STATE };
        const value: unknown = JSON.parse(content);
        if (
            !value || typeof value !== "object" || Array.isArray(value) ||
            !("version" in value) || value.version !== 1 || !("window" in value)
        ) return { ...DEFAULT_DESKTOP_WINDOW_STATE };
        return sanitizeDesktopWindowState(value.window);
    } catch (error) {
        if (
            error instanceof Deno.errors.NotFound ||
            error instanceof SyntaxError
        ) {
            return { ...DEFAULT_DESKTOP_WINDOW_STATE };
        }
        throw error;
    }
}

/** A single writer prevents overlapping resize/hide/quit saves from racing. */
export function createDesktopWindowStateStore(dataDirectory: string) {
    const path = join(dataDirectory, "desktop-window.json");
    let pending: DesktopWindowState | undefined;
    let saving: Promise<void> | undefined;

    async function write(state: DesktopWindowState): Promise<void> {
        await Deno.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
        const temporary = join(
            dataDirectory,
            `.desktop-window-${crypto.randomUUID()}.tmp`,
        );
        try {
            await Deno.writeTextFile(
                temporary,
                `${JSON.stringify({ version: 1, window: state }, null, 2)}\n`,
                { mode: 0o600, createNew: true },
            );
            await Deno.rename(temporary, path);
        } finally {
            try {
                await Deno.remove(temporary);
            } catch {
                /* Preserve the write error; a renamed file is already gone. */
            }
        }
    }

    function save(state: DesktopWindowState): Promise<void> {
        pending = sanitizeDesktopWindowState(state);
        if (!saving) {
            // A microtask combines saves triggered together in the same turn.
            saving = Promise.resolve().then(async () => {
                try {
                    while (pending) {
                        const next = pending;
                        pending = undefined;
                        await write(next);
                    }
                } finally {
                    pending = undefined;
                    saving = undefined;
                }
            });
        }
        return saving;
    }

    return {
        load: () => loadDesktopWindowState(dataDirectory),
        save,
    };
}

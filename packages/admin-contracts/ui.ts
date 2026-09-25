/** JSON-only UI extension boundary. This module is safe in server and browser. */
export type UiJsonValue =
    | null
    | boolean
    | number
    | string
    | readonly UiJsonValue[]
    | UiJsonObject;
export interface UiJsonObject {
    readonly [key: string]: UiJsonValue;
}

export type UiSlot =
    | "dashboard.widget"
    | "source.status"
    | "settings.section"
    | "nav.tab";
export type UiTone = "neutral" | "success" | "warning" | "danger";

export interface UiAction {
    readonly id: string;
    readonly payload: UiJsonObject;
}

/** Own-property path within the host's redacted context.data; never an expression. */
export type UiValuePath = readonly string[];

export type UiBlock =
    | {
        readonly kind: "metric";
        readonly label: string;
        readonly value: string | number;
        readonly valueFrom?: UiValuePath;
        readonly unit?: string;
        readonly tone?: UiTone;
    }
    | {
        readonly kind: "text";
        readonly text: string;
        readonly textFrom?: UiValuePath;
    }
    | {
        readonly kind: "badge";
        readonly label: string;
        readonly labelFrom?: UiValuePath;
        readonly tone?: UiTone;
    }
    | { readonly kind: "link"; readonly label: string; readonly href: string }
    | {
        readonly kind: "action";
        readonly label: string;
        readonly action: UiAction;
    };

/** Every extension includes a useful schema fallback, including executable UIs. */
export interface UiContribution {
    readonly pluginId: string;
    readonly id: string;
    readonly slot: UiSlot;
    readonly title: string;
    readonly description?: string;
    readonly order?: number;
    /** Mandatory for source.status; identifies the source plugin, not credentials. */
    readonly sourcePluginId?: string;
    readonly schema: { readonly blocks: readonly UiBlock[] };
    readonly render?:
        | { readonly kind: "trusted"; readonly modulePath: string }
        | { readonly kind: "sandbox"; readonly documentPath: string };
}

export interface UiContext {
    readonly locale: "zh";
    readonly theme: "light" | "dark" | "system";
    readonly sourceId?: string;
    readonly sourcePluginId?: string;
    /** Host-selected, redacted data only. Never include admin credentials. */
    readonly data: UiJsonObject;
}

/** Host configuration, never copied from a plugin manifest or its context. */
export interface UiPolicy {
    readonly trustedModules?: Readonly<Record<string, string>>;
    readonly sandboxDocuments?: Readonly<Record<string, string>>;
    readonly allowedActions?: Readonly<Record<string, readonly string[]>>;
}

export type UiRender =
    | { readonly kind: "schema" }
    | { readonly kind: "trusted"; readonly modulePath: string }
    | { readonly kind: "sandbox"; readonly documentPath: string };

export const UI_LIMITS = {
    contributions: 32,
    blocks: 16,
    title: 80,
    text: 1024,
    jsonBytes: 16_384,
    jsonDepth: 6,
    frameMinHeight: 96,
    frameMaxHeight: 480,
} as const;

const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const slots: readonly UiSlot[] = [
    "dashboard.widget",
    "source.status",
    "settings.section",
    "nav.tab",
];
const tones: readonly UiTone[] = ["neutral", "success", "warning", "danger"];

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" &&
        !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype ||
            Object.getPrototypeOf(value) === null);
}

function boundedText(
    value: unknown,
    maximum: number = UI_LIMITS.text,
): value is string {
    return typeof value === "string" && value.length > 0 &&
        value.length <= maximum;
}

function jsonValue(
    value: unknown,
    depth: number,
    budget: { remaining: number },
): value is UiJsonValue {
    // postMessage preserves shared references. Bound traversal before stringify
    // so a small graph cannot expand into an enormous repeated JSON tree.
    budget.remaining--;
    if (depth > UI_LIMITS.jsonDepth || budget.remaining < 0) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") {
        budget.remaining -= value.length;
        return budget.remaining >= 0;
    }
    if (Array.isArray(value)) {
        return value.length <= 128 &&
            value.every((item) => jsonValue(item, depth + 1, budget));
    }
    if (!record(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 128 &&
        entries.every(([key, item]) => {
            budget.remaining -= key.length;
            return key.length <= 128 &&
                !["__proto__", "constructor", "prototype"].includes(key) &&
                jsonValue(item, depth + 1, budget);
        });
}

export function isUiJsonObject(value: unknown): value is UiJsonObject {
    if (
        !record(value) ||
        !jsonValue(value, 0, { remaining: UI_LIMITS.jsonBytes })
    ) return false;
    return new TextEncoder().encode(JSON.stringify(value)).length <=
        UI_LIMITS.jsonBytes;
}

export function isUiAction(value: unknown): value is UiAction {
    return record(value) && typeof value.id === "string" &&
        identifier.test(value.id) && isUiJsonObject(value.payload) &&
        Object.keys(value).every((key) => ["id", "payload"].includes(key));
}

/** Schema links can navigate the console only; no external URLs or API calls. */
export function safeUiHref(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 512) return false;
    if (/^#[a-zA-Z][\w.-]{0,79}$/.test(value)) return true;
    if (!/^\/admin(?:\?|$)/.test(value)) return false;
    try {
        const url = new URL(value, "https://heimdall.invalid");
        if (url.pathname !== "/admin" || url.hash) return false;
        if (
            [...url.searchParams.keys()].some((key) =>
                !["view", "tab"].includes(key) ||
                url.searchParams.getAll(key).length !== 1
            )
        ) return false;
        const view = url.searchParams.get("view");
        const tab = url.searchParams.get("tab");
        return (view === null ||
            ["overview", "channels", "settings", "plugin"].includes(view)) &&
            (tab === null || /^[\w.:-]{1,161}$/.test(tab));
    } catch {
        return false;
    }
}

/** Canonical self-hosted assets only. Reject encoded paths and traversal. */
export function safeUiAssetPath(
    value: unknown,
    extension: "js" | "html",
): value is string {
    if (typeof value !== "string" || value.length > 256) return false;
    const path = /^\/admin\/assets\/plugins\/([a-zA-Z0-9_/-]+)\.([a-z]+)$/.exec(
        value,
    );
    return Boolean(
        path && path[2] === extension &&
            path[1]?.split("/").every((part) => part.length > 0),
    );
}

function validBlock(value: unknown): value is UiBlock {
    if (!record(value)) return false;
    if (value.kind === "text") {
        return boundedText(value.text) &&
            (value.textFrom === undefined || validValuePath(value.textFrom));
    }
    if (!boundedText(value.label, UI_LIMITS.title)) return false;
    if (value.tone !== undefined && !tones.includes(value.tone as UiTone)) {
        return false;
    }
    switch (value.kind) {
        case "metric":
            return (boundedText(value.value, UI_LIMITS.title) ||
                (typeof value.value === "number" &&
                    Number.isFinite(value.value))) &&
                (value.valueFrom === undefined ||
                    validValuePath(value.valueFrom)) &&
                (value.unit === undefined || boundedText(value.unit, 24));
        case "badge":
            return value.labelFrom === undefined ||
                validValuePath(value.labelFrom);
        case "link":
            return safeUiHref(value.href);
        case "action":
            return isUiAction(value.action);
        default:
            return false;
    }
}

function validValuePath(value: unknown): value is UiValuePath {
    return Array.isArray(value) && value.length > 0 &&
        value.length <= UI_LIMITS.jsonDepth &&
        value.every((part) =>
            typeof part === "string" &&
            /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(part) &&
            !["__proto__", "constructor", "prototype"].includes(part)
        );
}

/** Resolve a scalar only; missing/invalid data keeps the manifest's SSR fallback. */
export function resolveUiBlock(block: UiBlock, context: UiContext): UiBlock {
    const path = block.kind === "metric"
        ? block.valueFrom
        : block.kind === "text"
        ? block.textFrom
        : block.kind === "badge"
        ? block.labelFrom
        : undefined;
    if (!validValuePath(path)) return block;
    let value: unknown = context.data;
    for (const part of path) {
        if (!record(value)) return block;
        const descriptor = Object.getOwnPropertyDescriptor(value, part);
        if (!descriptor || !("value" in descriptor)) return block;
        value = descriptor.value;
    }
    if (block.kind === "metric") {
        return boundedText(value, UI_LIMITS.title) ||
                (typeof value === "number" && Number.isFinite(value))
            ? { ...block, value }
            : block;
    }
    if (block.kind === "text" && boundedText(value)) {
        return { ...block, text: value };
    }
    if (block.kind === "badge" && boundedText(value, UI_LIMITS.title)) {
        return { ...block, label: value };
    }
    return block;
}

function validContribution(value: unknown): value is UiContribution {
    if (!record(value)) return false;
    if (
        typeof value.pluginId !== "string" ||
        !identifier.test(value.pluginId) ||
        typeof value.id !== "string" || !identifier.test(value.id) ||
        !slots.includes(value.slot as UiSlot) ||
        !boundedText(value.title, UI_LIMITS.title) ||
        (value.description !== undefined && !boundedText(value.description)) ||
        (value.order !== undefined &&
            (typeof value.order !== "number" ||
                !Number.isSafeInteger(value.order) ||
                Math.abs(value.order) > 10_000)) ||
        (value.sourcePluginId !== undefined &&
            (typeof value.sourcePluginId !== "string" ||
                !identifier.test(value.sourcePluginId))) ||
        (value.slot === "source.status" && !value.sourcePluginId)
    ) return false;
    if (
        !record(value.schema) || !Array.isArray(value.schema.blocks) ||
        value.schema.blocks.length < 1 ||
        value.schema.blocks.length > UI_LIMITS.blocks ||
        !value.schema.blocks.every(validBlock)
    ) return false;
    if (value.render === undefined) return true;
    if (!record(value.render)) return false;
    return (value.render.kind === "trusted" &&
        safeUiAssetPath(value.render.modulePath, "js")) ||
        (value.render.kind === "sandbox" &&
            safeUiAssetPath(value.render.documentPath, "html"));
}

/** Parse manifest `ui` data at registration, before rendering or serialization. */
export function parseUiContributions(
    value: unknown,
): readonly UiContribution[] {
    if (!Array.isArray(value) || value.length > UI_LIMITS.contributions) {
        throw new TypeError(
            "UI contributions must be an array of at most 32 entries",
        );
    }
    const seen = new Set<string>();
    return value.map((entry, index) => {
        if (!isUiJsonObject(entry) || !validContribution(entry)) {
            throw new TypeError(`Invalid UI contribution at index ${index}`);
        }
        const key = uiContributionKey(entry);
        if (seen.has(key)) {
            throw new TypeError(`Duplicate UI contribution: ${key}`);
        }
        seen.add(key);
        // Copy the JSON boundary so a caller cannot mutate a validated manifest.
        return JSON.parse(JSON.stringify(entry)) as UiContribution;
    });
}

/** Bind a manifest to its own namespace; plugin trust never grants UI execution. */
export function parseManifestUi(manifest: unknown): readonly UiContribution[] {
    if (
        !record(manifest) || typeof manifest.id !== "string" ||
        !identifier.test(manifest.id)
    ) {
        throw new TypeError("UI manifest requires a valid plugin id");
    }
    if (manifest.ui === undefined) return [];
    const contributions = parseUiContributions(manifest.ui);
    if (contributions.some((entry) => entry.pluginId !== manifest.id)) {
        throw new TypeError(
            "UI contributions must use their manifest's plugin id",
        );
    }
    return contributions;
}

export function uiContributionKey(
    value: Pick<UiContribution, "pluginId" | "id">,
): string {
    return `${value.pluginId}:${value.id}`;
}

export function resolveUiRender(
    contribution: UiContribution,
    policy: UiPolicy = {},
): UiRender {
    const key = uiContributionKey(contribution);
    const render = contribution.render;
    if (
        render?.kind === "trusted" &&
        safeUiAssetPath(render.modulePath, "js") &&
        Object.hasOwn(policy.trustedModules ?? {}, key) &&
        policy.trustedModules?.[key] === render.modulePath
    ) return render;
    if (
        render?.kind === "sandbox" &&
        safeUiAssetPath(render.documentPath, "html") &&
        Object.hasOwn(policy.sandboxDocuments ?? {}, key) &&
        policy.sandboxDocuments?.[key] === render.documentPath
    ) return render;
    return { kind: "schema" };
}

export function uiActionAllowed(
    contribution: UiContribution,
    action: unknown,
    policy: UiPolicy = {},
): action is UiAction {
    const key = uiContributionKey(contribution);
    return isUiAction(action) &&
        Object.hasOwn(policy.allowedActions ?? {}, key) &&
        policy.allowedActions?.[key]?.includes(action.id) === true;
}

export function selectUiContributions(
    contributions: readonly UiContribution[],
    slot: UiSlot,
    context?: UiContext,
): readonly UiContribution[] {
    return contributions.filter((item) =>
        item.slot === slot &&
        (slot !== "source.status" ||
            item.sourcePluginId === context?.sourcePluginId)
    ).toSorted((left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        uiContributionKey(left).localeCompare(uiContributionKey(right), "en")
    );
}

/** Navigation targets are generated by the host, never supplied by a plugin. */
export function pluginNavItems(
    contributions: readonly UiContribution[],
): readonly { id: string; label: string; href: string }[] {
    return selectUiContributions(contributions, "nav.tab").map((entry) => ({
        id: uiContributionKey(entry),
        label: entry.title,
        href: `/admin?view=plugin&tab=${
            encodeURIComponent(uiContributionKey(entry))
        }`,
    }));
}

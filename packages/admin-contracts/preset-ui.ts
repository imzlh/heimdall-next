import { copyFormJson } from "./form-json.ts";
import type { UiJsonObject, UiJsonValue } from "./ui.ts";
import type { SourceProxySelection } from "./proxies.ts";
import type { SourceDraftProbeResult } from "./source-probe.ts";
import {
    parseSourceModelMap,
    type SourceModelMap,
} from "./source-model-map.ts";

export type PresetJsonValue = UiJsonValue;
export type PresetJsonObject = UiJsonObject;

export const PRESET_UI_ACTION_EVENT = "heimdall:preset-action";
export const PRESET_UI_FEEDBACK_EVENT = "heimdall:preset-feedback";
export const PRESET_UI_MODEL_MAP_EVENT = "heimdall:preset-model-map";
export const PRESET_UI_LIMITS = {
    contextBytes: 524_288,
    actionBytes: 524_288,
    configBytes: 65_536,
    feedbackBytes: 16_384,
} as const;

/** Host-selected identity only: no admin credentials or saved source secrets. */
export interface PresetUiContext {
    readonly draft: {
        readonly name: string;
        readonly priority: number;
        readonly id: string;
    };
    readonly sourcePluginId: string;
    readonly presetId: string;
    /** A public host choice, never a proxy endpoint or credentials. */
    readonly proxy?: SourceProxySelection;
    /** Public routing metadata, independent of the provider configuration. */
    readonly modelMap?: SourceModelMap;
}

/** Newly entered configuration travels to the host; the host owns persistence. */
export interface PresetUiAction {
    readonly kind: "save" | "preview" | "probe";
    readonly config: PresetJsonObject;
    /** Optional replacement of the host mapping, for model discovery shortcuts. */
    readonly modelMap?: SourceModelMap;
}

/** Feedback never echoes submitted configuration or backend response bodies. */
export interface PresetUiFeedback {
    readonly kind: PresetUiAction["kind"];
    readonly status: "pending" | "success" | "error";
    readonly errors?: Readonly<Record<string, string>>;
    readonly probe?: SourceDraftProbeResult;
}

const pluginId = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

export function parsePresetUiContext(value: unknown): PresetUiContext {
    const context = jsonObject(value, PRESET_UI_LIMITS.contextBytes);
    keys(context, ["draft", "sourcePluginId", "presetId"], [
        "proxy",
        "modelMap",
    ]);
    const modelMap = context.modelMap === undefined
        ? undefined
        : parseSourceModelMap(context.modelMap);
    if (context.proxy !== undefined) {
        const proxy = record(context.proxy);
        if (proxy.mode === "proxy") {
            keys(proxy, ["mode", "proxyId"]);
            ensure(
                typeof proxy.proxyId === "string" &&
                    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(proxy.proxyId),
                "invalid proxy id",
            );
        } else {
            keys(proxy, ["mode"]);
            ensure(
                proxy.mode === "inherit" || proxy.mode === "direct",
                "invalid proxy selection",
            );
        }
    }
    const draft = record(context.draft);
    keys(draft, ["name", "priority", "id"]);
    ensure(text(draft.name, 120), "invalid draft name");
    ensure(text(draft.id, 256), "invalid draft id");
    ensure(Number.isSafeInteger(draft.priority), "invalid priority");
    for (const key of ["sourcePluginId", "presetId"]) {
        ensure(
            typeof context[key] === "string" && pluginId.test(context[key]),
            "invalid plugin id",
        );
    }
    return {
        ...context,
        ...(modelMap ? { modelMap } : {}),
    } as unknown as PresetUiContext;
}

export function parsePresetUiAction(value: unknown): PresetUiAction {
    const action = jsonObject(value, PRESET_UI_LIMITS.actionBytes);
    keys(action, ["kind", "config"], ["modelMap"]);
    const modelMap = action.modelMap === undefined
        ? undefined
        : parseSourceModelMap(action.modelMap);
    ensure(
        action.kind === "save" || action.kind === "preview" ||
            action.kind === "probe",
        "invalid action",
    );
    record(action.config);
    copyFormJson(action.config, PRESET_UI_LIMITS.configBytes);
    return {
        ...action,
        ...(modelMap ? { modelMap } : {}),
    } as unknown as PresetUiAction;
}

/** A preset can update the in-memory host draft without submitting credentials. */
export function parsePresetUiModelMap(value: unknown): SourceModelMap {
    return parseSourceModelMap(
        jsonObject(value, PRESET_UI_LIMITS.contextBytes),
    );
}

export function parsePresetUiFeedback(value: unknown): PresetUiFeedback {
    const feedback = jsonObject(value, PRESET_UI_LIMITS.feedbackBytes);
    keys(feedback, ["kind", "status"], ["errors", "probe"]);
    ensure(
        feedback.kind === "save" || feedback.kind === "preview" ||
            feedback.kind === "probe",
        "invalid action",
    );
    ensure(
        typeof feedback.status === "string" &&
            ["pending", "success", "error"].includes(feedback.status),
        "invalid status",
    );
    if (feedback.errors !== undefined) {
        const errors = Object.entries(record(feedback.errors));
        ensure(errors.length <= 128, "too many field errors");
        for (const [key, message] of errors) {
            ensure(
                text(key, 128) && text(message, 1024),
                "invalid field error",
            );
        }
    }
    if (feedback.probe !== undefined) {
        ensure(
            feedback.kind === "probe" && feedback.status === "success",
            "unexpected probe result",
        );
        const probe = record(feedback.probe);
        keys(probe, ["ok", "message", "checkedAt"], ["models"]);
        ensure(
            typeof probe.ok === "boolean" && text(probe.message, 1024) &&
                text(probe.checkedAt, 64) &&
                Number.isFinite(Date.parse(probe.checkedAt)),
            "invalid probe result",
        );
        if (probe.models !== undefined) {
            ensure(
                Array.isArray(probe.models) && probe.models.length <= 256 &&
                    probe.models.every((model) => text(model, 256)),
                "invalid models",
            );
        }
    }
    return feedback as unknown as PresetUiFeedback;
}

function jsonObject(value: unknown, maxBytes: number): PresetJsonObject {
    // Existing form JSON copying rejects getters, functions, cycles, reserved
    // keys and non-plain objects before JSON serialization can execute code.
    return record(copyFormJson(value, maxBytes)) as PresetJsonObject;
}

function record(value: unknown): Record<string, unknown> {
    ensure(
        value !== null && typeof value === "object" && !Array.isArray(value),
        "expected an object",
    );
    return value as Record<string, unknown>;
}

function keys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[] = [],
): void {
    ensure(
        required.every((key) => Object.hasOwn(value, key)) &&
            Object.keys(value).every((key) =>
                required.includes(key) || optional.includes(key)
            ),
        "unsupported or missing property",
    );
}

function text(value: unknown, maximum: number): value is string {
    return typeof value === "string" && value.trim().length > 0 &&
        value.length <= maximum;
}

function ensure(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new TypeError(`Invalid preset UI message: ${message}`);
    }
}

import type { CreateSourceInput } from "@heimdall/admin-contracts";
import type { SourceDraftProbeResult } from "@heimdall/admin-contracts/source-probe.ts";
import type { PresetPlugin, SourcePluginFactory } from "@heimdall/contracts";
import { SourceRegistry } from "@heimdall/kernel";
import type { ProxyPoolHandle } from "./proxy-pool.ts";
import { probeSource } from "./probe-loop.ts";
import {
    applySourceModelMap,
    sourceModelSettings,
} from "./source-model-mapping.ts";

export interface DraftProbeDependencies {
    readonly factories: ReadonlyMap<string, SourcePluginFactory>;
    readonly presets: readonly PresetPlugin[];
    readonly enabled: (pluginId: string) => boolean;
    readonly proxies: ProxyPoolHandle;
    readonly timeoutMs?: number;
}

/** The source plugin owns transport; the host only supplies the selected proxy. */
export async function probeSourceDraft(
    input: CreateSourceInput,
    signal: AbortSignal,
    dependencies: DraftProbeDependencies,
): Promise<SourceDraftProbeResult> {
    signal.throwIfAborted();
    const factory = dependencies.factories.get(input.sourcePluginId);
    if (!factory || !dependencies.enabled(input.sourcePluginId)) {
        throw new DraftProbeError(
            404,
            "source_not_found",
            "源插件不可用，请重新选择。",
        );
    }
    const selection = dependencies.proxies.validateSelection(input.proxy);
    const submitted = sourceModelSettings(input.config, input.modelMap);
    let raw = submitted.config;
    if (input.presetId) {
        const preset = dependencies.presets.find((item) =>
            item.manifest.id === input.presetId
        );
        if (!preset || !dependencies.enabled(input.presetId)) {
            throw new DraftProbeError(
                404,
                "preset_not_found",
                "预设不可用，请重新选择。",
            );
        }
        if (preset.sourcePluginId !== input.sourcePluginId) {
            throw new DraftProbeError(
                400,
                "preset_source_mismatch",
                "预设与源插件不匹配。",
            );
        }
        // A preset can receive the public draft identity; the ephemeral source
        // itself always gets a fresh id, even when a caller supplies a saved id.
        let application;
        try {
            application = preset.apply({ ...object(raw), id: input.id });
        } catch {
            throw new DraftProbeError(
                400,
                "invalid_config",
                "预设校验失败，请检查连接参数。",
            );
        }
        if (application.sourcePluginId !== input.sourcePluginId) {
            throw new DraftProbeError(
                400,
                "preset_source_mismatch",
                "预设与源插件不匹配。",
            );
        }
        raw = application.config;
    }
    const id = crypto.randomUUID();
    let config;
    const settings = sourceModelSettings(raw, submitted.modelMap);
    try {
        config = factory.validate({ ...object(settings.config), id });
    } catch {
        // Third-party validators may put credentials into exception messages.
        throw new DraftProbeError(
            400,
            "invalid_config",
            "配置校验失败，请检查连接参数。",
        );
    }
    let source;
    try {
        source = applySourceModelMap(
            factory.create(config, {
                getProxy: () => dependencies.proxies.resolve(selection),
                onConfigUpdate: () => Promise.resolve(),
            }),
            settings.modelMap,
        );
    } catch {
        // Initialization errors can contain credentials just like validators.
        throw new DraftProbeError(
            400,
            "invalid_config",
            "无法初始化源插件，请检查连接参数。",
        );
    }
    if (!source.probe) {
        throw new DraftProbeError(
            422,
            "probe_unsupported",
            "此源插件暂不支持连接测试；可以直接保存配置。",
        );
    }
    const registry = new SourceRegistry();
    registry.register(source);
    const lifetime = new AbortController();
    try {
        const result = await probeSource(registry, source.id, {
            signal: AbortSignal.any([signal, lifetime.signal]),
            timeoutMs: dependencies.timeoutMs,
        });
        const secrets = [
            ...secretStrings(config),
            ...secretStrings(dependencies.proxies.resolve(selection)),
        ];
        let modelBytes = 0;
        const models = result?.ok && Array.isArray(result.models)
            ? [
                ...new Set(
                    result.models.filter((model) =>
                        typeof model === "string" && model.length <= 256 &&
                        !/\p{Cc}/u.test(model) &&
                        !secrets.some((secret) => model.includes(secret))
                    ).map((model) => model.trim()).filter(Boolean),
                ),
            ].sort().slice(0, 256).filter((model) => {
                modelBytes += new TextEncoder().encode(model).length + 4;
                return modelBytes <= 12_000;
            })
            : undefined;
        return {
            ok: result?.ok === true,
            message: result?.ok
                ? "连接正常。模型列表由源插件提供。"
                : result?.message === "probe timed out"
                ? "连接超时，请检查地址、代理与网络后重试。"
                : "连接失败，请检查服务地址、凭据和代理后重试。",
            checkedAt: new Date().toISOString(),
            ...(models ? { models } : {}),
        };
    } finally {
        lifetime.abort();
    }
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DraftProbeError(
            400,
            "invalid_config",
            "配置必须是 JSON 对象。",
        );
    }
    return value as Record<string, unknown>;
}

function secretStrings(value: unknown, secret = false): string[] {
    if (typeof value === "string") return secret && value ? [value] : [];
    if (!value || typeof value !== "object") return [];
    return Object.entries(value).flatMap(([key, child]) =>
        secretStrings(
            child,
            secret || /key|token|secret|password|authorization/i.test(key),
        )
    );
}

class DraftProbeError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = "DraftProbeError";
    }
}

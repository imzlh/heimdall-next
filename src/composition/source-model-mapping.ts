import type { InferenceSource, SourceCapability } from "@heimdall/contracts";
import {
    parseSourceModelMap,
    type SourceModelMap,
} from "@heimdall/admin-contracts/source-model-map.ts";

const originals = new WeakMap<InferenceSource, InferenceSource>();

/** Replace mapped upstream names in the catalog; mappings are not recursive. */
export function publicSourceModels(
    models: readonly string[],
    mapping: SourceModelMap,
): string[] {
    const aliases = Object.entries(mapping);
    if (!Array.isArray(models)) return [];
    return [
        ...new Set(
            models.filter((model) => typeof model === "string").flatMap(
                (raw) => {
                    const model = raw.trim();
                    if (
                        !model || model.length > 256 ||
                        /[\s\p{Cc}\p{Cf}]/u.test(model)
                    ) return [];
                    const matches = aliases.filter(([, target]) =>
                        target === model
                    ).map(([alias]) => alias);
                    return matches.length
                        ? matches
                        : Object.hasOwn(mapping, model)
                        ? []
                        : [model];
                },
            ),
        ),
    ].sort();
}

/**
 * The host translates the routing trait only. Provider payloads, request ids,
 * metadata, cancellation and public run.started events retain their identity.
 * Source adapters consume traits.model as the effective execution model.
 */
export function applySourceModelMap(
    source: InferenceSource,
    value: unknown,
): InferenceSource {
    const original = originals.get(source) ?? source;
    const mapping = parseSourceModelMap(value);
    const aliases = Object.keys(mapping);
    if (aliases.length === 0) return original;
    const capabilities: SourceCapability[] = original.capabilities.flatMap(
        (capability) => {
            if (capability.models === undefined) {
                // Preserve wildcard routing while advertising configured aliases.
                return [capability, { ...capability, models: aliases }];
            }
            return [{
                ...capability,
                models: publicSourceModels(capability.models, mapping),
            }];
        },
    );
    const mapped: InferenceSource = {
        id: original.id,
        capabilities,
        async *execute(input, context) {
            const model = input.traits.model;
            const target = model === undefined || !Object.hasOwn(mapping, model)
                ? undefined
                : mapping[model];
            const execution = target === undefined || target === model
                ? input
                : {
                    ...input,
                    traits: { ...input.traits, model: target },
                };
            for await (const frame of original.execute(execution, context)) {
                yield frame.event.kind === "run.started" && execution !== input
                    ? {
                        ...frame,
                        event: { ...frame.event, request: input },
                    }
                    : frame;
            }
        },
        ...(original.probe === undefined ? {} : {
            async probe(signal: AbortSignal) {
                const result = await original.probe!(signal);
                return {
                    ...result,
                    ...(result.models === undefined ? {} : {
                        models: publicSourceModels(result.models, mapping),
                    }),
                };
            },
        }),
        ...(original.uiSnapshot === undefined
            ? {}
            : { uiSnapshot: () => original.uiSnapshot!() }),
    };
    originals.set(mapped, original);
    return mapped;
}

/** Old provider documents migrate into metadata before a plugin sees them. */
export function sourceModelSettings(config: unknown, explicit?: unknown): {
    config: unknown;
    modelMap: SourceModelMap;
} {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return { config, modelMap: parseSourceModelMap(explicit) };
    }
    const { modelMap: legacy, ...provider } = config as Record<string, unknown>;
    return {
        config: provider,
        modelMap: parseSourceModelMap(explicit ?? legacy),
    };
}

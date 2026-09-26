import type {
    InferenceSource,
    SourceProxySelection,
} from "@heimdall/contracts";

const originalSources = new WeakMap<InferenceSource, InferenceSource>();

/** Instance metadata belongs to the host, outside provider-owned raw config. */
export interface SourceRecordMetadata {
    readonly name?: string;
    readonly priority?: number;
    readonly proxy?: SourceProxySelection;
}

export interface StoredSourceConfig extends SourceRecordMetadata {
    readonly sourcePluginId: string;
    readonly config: unknown;
    readonly enabled?: boolean;
    /** Before v1, plugin switches also overwrote the instance enabled field. */
    readonly instanceStateVersion?: 1;
    /** An atomic, credential-free tombstone prevents environment resurrection. */
    readonly deleted?: boolean;
}

/** Every capability of an instance follows its host-configured routing priority. */
export function applySourcePriority(
    source: InferenceSource,
    priority: number | undefined,
): InferenceSource {
    if (priority === undefined) return source;
    if (!Number.isSafeInteger(priority)) {
        throw new TypeError("source priority must be a safe integer");
    }
    const original = originalSources.get(source) ?? source;
    const prioritized: InferenceSource = {
        id: original.id,
        capabilities: original.capabilities.map((capability) => ({
            ...capability,
            priority,
        })),
        execute: (input, context) => original.execute(input, context),
        ...(original.probe === undefined ? {} : {
            probe: (signal: AbortSignal) => original.probe!(signal),
        }),
    };
    originalSources.set(prioritized, original);
    return prioritized;
}

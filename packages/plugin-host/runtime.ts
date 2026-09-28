/**
 * Small host lifecycle implementation.
 *
 * The store and runtime factory are ports. This default implementation keeps
 * records in memory so the server can run before a KV/SQLite adapter exists;
 * production composition can provide a durable PluginRecordStore without
 * changing lifecycle semantics.
 */

import type {
    PluginArtifact,
    PluginHost,
    PluginHostOptions,
    PluginInvocation,
    PluginLifecycleErrorCode,
    PluginRecord,
    PluginRecordStore,
    PluginRuntime,
} from "./mod.ts";
import {
    DefaultPluginVerifier,
    PluginLifecycleError,
    PluginVerificationError,
    validatePluginManifest,
} from "./mod.ts";

function cloneManifest(
    manifest: PluginRecord["manifest"],
): PluginRecord["manifest"] {
    // Schemas and UI descriptors are nested JSON. A shallow copy would let a
    // caller change the artifact after verification or mutate stored metadata.
    return freezeManifest(structuredClone(manifest));
}

function freezeManifest<T>(value: T): T {
    if (value !== null && typeof value === "object") {
        for (const child of Object.values(value)) freezeManifest(child);
        Object.freeze(value);
    }
    return value;
}

function cloneRecord(record: PluginRecord): PluginRecord {
    return Object.freeze({
        ...record,
        manifest: cloneManifest(record.manifest),
    });
}

function cloneArtifact(artifact: PluginArtifact): PluginArtifact {
    return Object.freeze({
        ...artifact,
        manifest: cloneManifest(artifact.manifest),
        ...(artifact.bytes === undefined
            ? {}
            : { bytes: new Uint8Array(artifact.bytes) }),
        ...(artifact.signature === undefined
            ? {}
            : { signature: new Uint8Array(artifact.signature) }),
    });
}

/** Deterministic in-memory metadata store useful for tests and local startup. */
export class InMemoryPluginRecordStore implements PluginRecordStore {
    #records = new Map<string, PluginRecord>();

    get(id: string): Promise<PluginRecord | undefined> {
        const record = this.#records.get(id);
        return Promise.resolve(
            record === undefined ? undefined : cloneRecord(record),
        );
    }

    put(record: PluginRecord): Promise<void> {
        this.#records.set(record.manifest.id, cloneRecord(record));
        return Promise.resolve();
    }

    delete(id: string): Promise<void> {
        this.#records.delete(id);
        return Promise.resolve();
    }

    list(): Promise<readonly PluginRecord[]> {
        return Promise.resolve(Object.freeze(
            [...this.#records.values()]
                .sort((left, right) =>
                    left.manifest.id.localeCompare(right.manifest.id)
                )
                .map(cloneRecord),
        ));
    }
}

function lifecycleError(
    code: PluginLifecycleErrorCode,
    id: string,
    detail: string,
): PluginLifecycleError {
    return new PluginLifecycleError(code, `plugin ${id} ${detail}`);
}

function trustedIds(options: PluginHostOptions): Set<string> {
    return new Set([
        ...(options.policy?.trustedPluginIds ?? []),
        ...(options.policy?.trustedBuiltinIds ?? []),
    ]);
}

interface RuntimeState {
    readonly runtime: PluginRuntime;
    active: boolean;
}

function withAbort<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort);
            reject(signal.reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        // Keep both handlers even after cancellation to consume late failures.
        result.then((value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
        }, (error) => {
            signal.removeEventListener("abort", abort);
            reject(error);
        });
    });
}

/** In-memory lifecycle host with explicit verification and runtime activation. */
export class InMemoryPluginHost implements PluginHost {
    readonly #store: PluginRecordStore;
    readonly #verifier;
    readonly #policy;
    readonly #runtimeFactory;
    readonly #now;
    readonly #requireRuntimeOnEnable;
    readonly #artifacts = new Map<string, PluginArtifact>();
    readonly #runtimes = new Map<string, RuntimeState>();
    readonly #operations = new Map<string, Promise<void>>();
    readonly #invocations = new Map<string, Set<AbortController>>();

    constructor(options: PluginHostOptions = {}) {
        this.#policy = options.policy ?? {};
        this.#store = options.store ?? new InMemoryPluginRecordStore();
        this.#verifier = options.verifier ??
            new DefaultPluginVerifier(this.#policy);
        this.#runtimeFactory = options.runtimeFactory;
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#requireRuntimeOnEnable = options.requireRuntimeOnEnable ?? false;
    }

    async install(artifact: PluginArtifact): Promise<PluginRecord> {
        // Snapshot before yielding: verification and activation must use the
        // same bytes even when a caller later reuses its input buffers.
        // Normalize first: structuredClone would otherwise execute accessors
        // that the manifest validator deliberately rejects without reading.
        const manifest = validatePluginManifest(artifact.manifest);
        const snapshot = cloneArtifact({ ...artifact, manifest });
        return await this.#serialize(
            snapshot.manifest.id,
            () => this.#install(snapshot),
        );
    }

    async #install(artifact: PluginArtifact): Promise<PluginRecord> {
        const verification = await this.#verifier.verify(artifact);
        if (verification.status === "rejected") {
            throw new PluginVerificationError(
                "verification_rejected",
                verification.reason ??
                    `plugin verification rejected: ${artifact.manifest.id}`,
            );
        }
        const manifest = verification.manifest ??
            validatePluginManifest(artifact.manifest);
        if (manifest.id !== artifact.manifest.id) {
            throw new PluginVerificationError(
                "verification_rejected",
                "plugin identity changed during verification",
            );
        }
        const existing = await this.#store.get(manifest.id);
        if (existing !== undefined) {
            throw lifecycleError(
                "already_installed",
                manifest.id,
                "is already installed",
            );
        }
        const now = this.#now();
        const record: PluginRecord = Object.freeze({
            manifest,
            ...(verification.digest === undefined
                ? {}
                : { digest: verification.digest }),
            ...(verification.signerKeyId === undefined
                ? {}
                : { signerKeyId: verification.signerKeyId }),
            enabled: false,
            isolated: manifest.trust === "isolated",
            updatedAt: now,
            ...(verification.status === "unverified" &&
                    verification.reason !== undefined
                ? { lastError: verification.reason }
                : {}),
        });
        if (this.#store.install === undefined) {
            await this.#store.put(record);
        } else {
            await this.#store.install(record, cloneArtifact({ ...artifact, manifest }));
        }
        this.#artifacts.set(
            manifest.id,
            cloneArtifact({ ...artifact, manifest }),
        );
        return cloneRecord(record);
    }

    enable(id: string): Promise<PluginRecord> {
        return this.#serialize(id, () => this.#enable(id));
    }

    async #enable(id: string, restored?: PluginRecord): Promise<PluginRecord> {
        const record = restored ?? await this.#require(id);
        if (record.manifest.trust === "trusted") {
            const allowlist = trustedIds({ policy: this.#policy });
            if (this.#policy.source !== "builtin" || !allowlist.has(id)) {
                throw lifecycleError(
                    "policy_denied",
                    id,
                    "is not allowlisted for trusted execution",
                );
            }
        }
        const state = this.#runtimes.get(id);
        if (state !== undefined && !state.active) {
            // A failed stop does not prove that resources were released. Retry
            // cleanup before allowing a second instance of the same plugin.
            await this.#stopRuntime(id);
        }
        if (record.enabled) return cloneRecord(record);
        if (
            this.#runtimeFactory === undefined &&
            (this.#requireRuntimeOnEnable || record.isolated)
        ) {
            throw lifecycleError(
                "runtime_required",
                id,
                "has no runtime factory",
            );
        }
        let runtime: PluginRuntime | undefined;
        try {
            if (this.#runtimeFactory !== undefined) {
                const artifact = await this.#loadArtifact(record);
                if (artifact === undefined) {
                    throw lifecycleError(
                        "runtime_required",
                        id,
                        "has no in-memory artifact",
                    );
                }
                runtime = await this.#runtimeFactory(cloneArtifact(artifact));
                this.#runtimes.set(id, { runtime, active: false });
                await runtime.start(cloneArtifact(artifact));
            }
        } catch (error) {
            if (runtime !== undefined) {
                try {
                    await this.#stopRuntime(id);
                } catch {
                    // Preserve the startup failure as the actionable error.
                }
            }
            let cause = error;
            try {
                await this.#store.put({
                    ...record,
                    enabled: false,
                    updatedAt: this.#now(),
                    lastError: error instanceof Error
                        ? error.message
                        : String(error),
                });
            } catch (persistenceError) {
                cause = new AggregateError(
                    [error, persistenceError],
                    "runtime startup and failure persistence both failed",
                );
            }
            throw new PluginLifecycleError(
                "runtime_failed",
                `plugin ${id} runtime failed to start`,
                { cause },
            );
        }
        const enabled: PluginRecord = Object.freeze({
            ...record,
            enabled: true,
            updatedAt: this.#now(),
            ...(record.lastError === undefined ? {} : { lastError: undefined }),
        });
        try {
            await this.#store.put(enabled);
        } catch (error) {
            if (runtime !== undefined) {
                try {
                    await this.#stopRuntime(id);
                } catch {
                    // Keep the persistence error as the primary failure.
                }
            }
            throw new PluginLifecycleError(
                "runtime_failed",
                `plugin ${id} state failed to persist`,
                { cause: error },
            );
        }
        const enabledRuntime = this.#runtimes.get(id);
        if (enabledRuntime !== undefined) enabledRuntime.active = true;
        return cloneRecord(enabled);
    }

    disable(id: string): Promise<PluginRecord> {
        return this.#serialize(id, () => this.#disable(id));
    }

    async #disable(id: string): Promise<PluginRecord> {
        const record = await this.#require(id);
        const runtime = this.#runtimes.get(id);
        if (!record.enabled && runtime === undefined) {
            return cloneRecord(record);
        }
        const disabled: PluginRecord = Object.freeze({
            ...record,
            enabled: false,
            updatedAt: this.#now(),
            lastError: undefined,
        });
        // Do not tear down a healthy runtime if durable disable was rejected.
        await this.#store.put(disabled);
        this.#abortInvocations(id);
        try {
            await this.#stopRuntime(id);
        } catch (error) {
            try {
                await this.#store.put({
                    ...disabled,
                    lastError: error instanceof Error
                        ? error.message
                        : String(error),
                });
            } catch (persistenceError) {
                throw new PluginLifecycleError(
                    "runtime_failed",
                    `plugin ${id} runtime failed to stop`,
                    {
                        cause: new AggregateError(
                            [error, persistenceError],
                            "runtime stop and failure persistence both failed",
                        ),
                    },
                );
            }
            throw error;
        }
        return cloneRecord(disabled);
    }

    uninstall(id: string): Promise<boolean> {
        return this.#serialize(id, () => this.#uninstall(id));
    }

    async #uninstall(id: string): Promise<boolean> {
        const record = await this.#store.get(id);
        if (record === undefined) return false;
        await this.#disable(id);
        await this.#store.delete(id);
        this.#artifacts.delete(id);
        return true;
    }

    get(id: string): Promise<PluginRecord | undefined> {
        return this.#serialize(id, () => this.#read(id));
    }

    async list(): Promise<readonly PluginRecord[]> {
        const records = await this.#store.list();
        const reconciled = await Promise.all(
            records.map((record) => this.get(record.manifest.id)),
        );
        return Object.freeze(
            reconciled.filter((record) => record !== undefined)
                .map(cloneRecord),
        );
    }

    async #loadArtifact(record: PluginRecord): Promise<PluginArtifact | undefined> {
        const cached = this.#artifacts.get(record.manifest.id);
        if (cached !== undefined) return cached;
        const artifact = await this.#store.readArtifact?.(record.manifest.id);
        if (artifact === undefined) return undefined;
        const verification = await this.#verifier.verify(artifact);
        const manifest = verification.manifest ?? validatePluginManifest(artifact.manifest);
        if (
            verification.status === "rejected" ||
            verification.digest !== record.digest ||
            verification.signerKeyId !== record.signerKeyId ||
            JSON.stringify(manifest) !== JSON.stringify(validatePluginManifest(record.manifest))
        ) {
            throw new PluginVerificationError("verification_rejected", "persisted plugin package failed verification");
        }
        const snapshot = cloneArtifact({ ...artifact, manifest });
        this.#artifacts.set(record.manifest.id, snapshot);
        return snapshot;
    }

    async restore(): Promise<readonly PluginRecord[]> {
        const records = await this.#store.list();
        await Promise.all(records.map((saved) => this.#serialize(saved.manifest.id, async () => {
            const record = await this.#store.get(saved.manifest.id);
            if (record === undefined || !record.enabled || this.#runtimes.get(record.manifest.id)?.active) return;
            try {
                await this.#enable(record.manifest.id, { ...record, enabled: false });
            } catch (error) {
                // One broken package must not prevent unrelated plugins from restoring.
                await this.#store.put({ ...record, enabled: false, updatedAt: this.#now(), lastError: error instanceof Error ? error.message : String(error) });
            }
        })));
        return await this.list();
    }

    async close(): Promise<void> {
        const ids = new Set([...this.#operations.keys(), ...this.#runtimes.keys()]);
        const results = await Promise.allSettled([...ids].map((id) => this.#serialize(id, async () => {
            this.#abortInvocations(id);
            await this.#stopRuntime(id);
        })));
        const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
        if (failures.length) throw new AggregateError(failures, "plugin shutdown failed");
    }

    /** Invoke an active runtime without exposing runtime instances to callers. */
    async invoke(
        id: string,
        invocation: PluginInvocation,
    ): Promise<Awaited<ReturnType<PluginRuntime["invoke"]>>> {
        invocation.signal?.throwIfAborted();
        // Serialize admission, not execution. A disable can always cancel an
        // in-flight invocation, including a runtime that ignores its signal.
        const admission = this.#serialize(id, async () => {
            invocation.signal?.throwIfAborted();
            const record = await this.#require(id);
            invocation.signal?.throwIfAborted();
            if (!record.enabled) {
                throw lifecycleError("policy_denied", id, "is disabled");
            }
            const runtime = this.#runtimes.get(id);
            if (runtime === undefined || !runtime.active) {
                throw lifecycleError(
                    "runtime_required",
                    id,
                    "has no active runtime",
                );
            }
            return {
                result: this.#invokeRuntime(id, runtime.runtime, invocation),
            };
        });
        const { result } =
            await (invocation.signal === undefined
                ? admission
                : withAbort(admission, invocation.signal));
        return await result;
    }

    #invokeRuntime(
        id: string,
        runtime: PluginRuntime,
        invocation: PluginInvocation,
    ): Promise<Awaited<ReturnType<PluginRuntime["invoke"]>>> {
        const controller = new AbortController();
        const active = this.#invocations.get(id) ?? new Set<AbortController>();
        this.#invocations.set(id, active);
        active.add(controller);
        const callerAbort = () => controller.abort(invocation.signal?.reason);
        invocation.signal?.addEventListener("abort", callerAbort, {
            once: true,
        });
        const execution = Promise.resolve().then(() => {
            controller.signal.throwIfAborted();
            return runtime.invoke({ ...invocation, signal: controller.signal });
        });
        const result = withAbort(execution, controller.signal).finally(() => {
            invocation.signal?.removeEventListener("abort", callerAbort);
            active.delete(controller);
            if (active.size === 0 && this.#invocations.get(id) === active) {
                this.#invocations.delete(id);
            }
        });
        // Admission resolves separately; attach an observer before yielding so
        // an immediate runtime failure cannot become an unhandled rejection.
        result.catch(() => {});
        return result;
    }

    #abortInvocations(id: string): void {
        for (const controller of this.#invocations.get(id) ?? []) {
            controller.abort(
                new DOMException(`plugin ${id} is disabled`, "AbortError"),
            );
        }
    }

    async #stopRuntime(id: string): Promise<void> {
        const state = this.#runtimes.get(id);
        if (state === undefined) return;
        state.active = false;
        try {
            await state.runtime.stop();
        } catch (error) {
            // Keep the reference so disable/uninstall/enable can retry cleanup.
            throw new PluginLifecycleError(
                "runtime_failed",
                `plugin ${id} runtime failed to stop`,
                { cause: error },
            );
        }
        this.#runtimes.delete(id);
    }

    #serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.#operations.get(id) ?? Promise.resolve();
        const result = previous.then(operation);
        // A rejected operation must not poison later enable/disable attempts.
        const settled = result.then(() => {}, () => {});
        this.#operations.set(id, settled);
        settled.then(() => {
            if (this.#operations.get(id) === settled) {
                this.#operations.delete(id);
            }
        });
        return result;
    }

    async #require(id: string): Promise<PluginRecord> {
        const record = await this.#read(id);
        if (record === undefined) {
            throw lifecycleError("not_installed", id, "is not installed");
        }
        return record;
    }

    async #read(id: string): Promise<PluginRecord | undefined> {
        const record = await this.#store.get(id);
        return record === undefined ? undefined : await this.#reconcile(record);
    }

    async #reconcile(record: PluginRecord): Promise<PluginRecord> {
        const requiresRuntime = record.isolated ||
            this.#requireRuntimeOnEnable ||
            this.#runtimeFactory !== undefined;
        if (
            !record.enabled || !requiresRuntime ||
            this.#runtimes.get(record.manifest.id)?.active
        ) return record;
        const stale: PluginRecord = Object.freeze({
            ...record,
            enabled: false,
            updatedAt: this.#now(),
            lastError: "runtime_required: plugin runtime is not active",
        });
        await this.#store.put(stale);
        return stale;
    }
}

export function createPluginHost(
    options: PluginHostOptions = {},
): InMemoryPluginHost {
    return new InMemoryPluginHost(options);
}

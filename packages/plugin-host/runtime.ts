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
        const previous = this.#records.get(record.manifest.id);
        if (previous?.revision !== record.revision) {
            return Promise.reject(
                lifecycleError(
                    "revision_conflict",
                    record.manifest.id,
                    "record changed before lifecycle update",
                ),
            );
        }
        this.#records.set(
            record.manifest.id,
            cloneRecord({ ...record, revision: crypto.randomUUID() }),
        );
        return Promise.resolve();
    }

    delete(id: string, expectedRevision?: string): Promise<void> {
        if (
            expectedRevision !== undefined &&
            this.#records.get(id)?.revision !== expectedRevision
        ) {
            return Promise.reject(
                lifecycleError(
                    "revision_conflict",
                    id,
                    "record changed before uninstall",
                ),
            );
        }
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
    readonly dependencies: readonly string[];
    active: boolean;
    unsubscribe?: () => void;
}

interface RuntimeFailure {
    readonly state: RuntimeState;
    readonly error: Error;
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
    readonly #externalDependencies;
    readonly #artifacts = new Map<string, PluginArtifact>();
    readonly #runtimes = new Map<string, RuntimeState>();
    readonly #failures = new Map<string, RuntimeFailure>();
    readonly #operations = new Map<string, Promise<void>>();
    #admissions: Promise<void> = Promise.resolve();
    readonly #invocations = new Map<string, Set<AbortController>>();
    #closed = false;

    constructor(options: PluginHostOptions = {}) {
        this.#policy = options.policy ?? {};
        this.#store = options.store ?? new InMemoryPluginRecordStore();
        this.#verifier = options.verifier ??
            new DefaultPluginVerifier(this.#policy);
        this.#runtimeFactory = options.runtimeFactory;
        this.#now = options.now ?? (() => new Date().toISOString());
        this.#requireRuntimeOnEnable = options.requireRuntimeOnEnable ?? false;
        this.#externalDependencies = options.externalDependencies ?? (() => []);
    }

    async install(artifact: PluginArtifact): Promise<PluginRecord> {
        this.#assertOpen();
        // Snapshot before yielding: verification and activation must use the
        // same bytes even when a caller later reuses its input buffers.
        // Normalize first: structuredClone would otherwise execute accessors
        // that the manifest validator deliberately rejects without reading.
        const manifest = validatePluginManifest(artifact.manifest);
        const snapshot = cloneArtifact({ ...artifact, manifest });
        return await this.#serializeMany(
            [snapshot.manifest.id, ...(snapshot.manifest.dependencies ?? [])],
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
            await this.#store.install(
                record,
                cloneArtifact({ ...artifact, manifest }),
            );
        }
        this.#artifacts.set(
            manifest.id,
            cloneArtifact({
                ...artifact,
                manifest,
                digest: verification.digest,
            }),
        );
        return cloneRecord((await this.#store.get(manifest.id)) ?? record);
    }

    async enable(id: string): Promise<PluginRecord> {
        this.#assertOpen();
        return await this.#withDependencies(id, () => this.#enable(id));
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
        if (state !== undefined && !this.#runtimeActive(id)) {
            // A failed stop does not prove that resources were released. Retry
            // cleanup before allowing a second instance of the same plugin.
            await this.#stopRuntime(id);
        }
        if (record.enabled) return cloneRecord(record);
        let runtime: PluginRuntime | undefined;
        try {
            await this.#requireDependencies(record);
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
                const starting: RuntimeState = {
                    runtime,
                    dependencies: record.manifest.dependencies ?? [],
                    active: false,
                };
                this.#runtimes.set(id, starting);
                starting.unsubscribe = runtime.onFailure?.((error) => {
                    this.#runtimeFailed(id, starting, error);
                });
                await runtime.start(cloneArtifact(artifact));
                const failure = this.#failures.get(id);
                if (failure !== undefined) throw failure.error;
                if (runtime.isActive?.() === false) {
                    throw new Error("plugin runtime stopped during startup");
                }
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
                this.#failures.delete(id);
            } catch (persistenceError) {
                cause = new AggregateError(
                    [error, persistenceError],
                    "runtime startup and failure persistence both failed",
                );
            }
            if (cause === error && error instanceof PluginLifecycleError) {
                throw error;
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
        let saved: PluginRecord;
        try {
            await this.#store.put(enabled);
            saved = (await this.#store.get(id)) ?? enabled;
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
        if (this.#failures.has(id) || runtime?.isActive?.() === false) {
            await this.#reconcile(saved);
            throw lifecycleError(
                "runtime_failed",
                id,
                "stopped while enabling",
            );
        }
        const enabledRuntime = this.#runtimes.get(id);
        if (enabledRuntime !== undefined) enabledRuntime.active = true;
        return cloneRecord(saved);
    }

    async disable(id: string): Promise<PluginRecord> {
        this.#assertOpen();
        return await this.#serialize(id, async () => {
            await this.#requireNoDependents(id, true);
            return await this.#disable(id);
        });
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
        const saved = (await this.#store.get(id)) ?? disabled;
        this.#abortInvocations(id);
        try {
            await this.#stopRuntime(id);
        } catch (error) {
            try {
                await this.#store.put({
                    ...saved,
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
        return cloneRecord(saved);
    }

    async uninstall(id: string): Promise<boolean> {
        this.#assertOpen();
        return await this.#serialize(id, () => this.#uninstall(id));
    }

    async #uninstall(id: string): Promise<boolean> {
        const record = await this.#store.get(id);
        if (record === undefined) return false;
        await this.#requireNoDependents(id, false);
        const disabled = await this.#disable(id);
        await this.#store.delete(id, disabled.revision);
        this.#artifacts.delete(id);
        this.#failures.delete(id);
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

    async #loadArtifact(
        record: PluginRecord,
    ): Promise<PluginArtifact | undefined> {
        const cached = this.#artifacts.get(record.manifest.id);
        if (
            cached !== undefined && cached.digest === record.digest &&
            JSON.stringify(cached.manifest) === JSON.stringify(record.manifest)
        ) return cached;
        const artifact = await this.#store.readArtifact?.(record.manifest.id);
        if (artifact === undefined) return undefined;
        const verification = await this.#verifier.verify(artifact);
        const manifest = verification.manifest ??
            validatePluginManifest(artifact.manifest);
        if (
            verification.status === "rejected" ||
            verification.digest !== record.digest ||
            verification.signerKeyId !== record.signerKeyId ||
            JSON.stringify(manifest) !==
                JSON.stringify(validatePluginManifest(record.manifest))
        ) {
            throw new PluginVerificationError(
                "verification_rejected",
                "persisted plugin package failed verification",
            );
        }
        const snapshot = cloneArtifact({
            ...artifact,
            manifest,
            digest: verification.digest,
        });
        this.#artifacts.set(record.manifest.id, snapshot);
        return snapshot;
    }

    async restore(): Promise<readonly PluginRecord[]> {
        this.#assertOpen();
        const records = await this.#store.list();
        const enabled = new Map(
            records.filter((record) => record.enabled).map((
                record,
            ) => [record.manifest.id, record]),
        );
        const visited = new Set<string>();
        const visit = async (
            id: string,
            ancestors = new Set<string>(),
        ): Promise<void> => {
            if (visited.has(id)) return;
            const saved = enabled.get(id);
            if (saved === undefined) return;
            if (ancestors.has(id)) {
                throw lifecycleError(
                    "dependency_unavailable",
                    id,
                    "has a dependency cycle",
                );
            }
            const next = new Set([...ancestors, id]);
            let dependencyError: unknown;
            try {
                for (const dependency of saved.manifest.dependencies ?? []) {
                    await visit(dependency, next);
                }
            } catch (error) {
                dependencyError = error;
            }
            visited.add(id);
            await this.#withDependencies(id, async () => {
                const record = await this.#store.get(id);
                if (
                    record === undefined || !record.enabled ||
                    this.#runtimeActive(id)
                ) return;
                try {
                    if (dependencyError !== undefined) throw dependencyError;
                    await this.#enable(id, { ...record, enabled: false });
                } catch (error) {
                    // Re-read because startup may already have persisted its own failure.
                    const latest = await this.#store.get(id);
                    if (latest !== undefined) {
                        await this.#store.put({
                            ...latest,
                            enabled: false,
                            updatedAt: this.#now(),
                            lastError: latest.lastError ??
                                (error instanceof Error
                                    ? error.message
                                    : String(error)),
                        });
                    }
                }
            });
        };
        // Restore prerequisites first; a failed branch does not stop other plugins.
        const failures: unknown[] = [];
        for (const id of enabled.keys()) {
            try {
                await visit(id);
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length) {
            throw new AggregateError(
                failures,
                "plugin restore state could not be persisted",
            );
        }
        return await this.list();
    }

    async close(): Promise<void> {
        this.#closed = true;
        await this.#admissions;
        const ids = new Set([
            ...this.#operations.keys(),
            ...this.#runtimes.keys(),
            ...this.#failures.keys(),
        ]);
        const results = await Promise.allSettled(
            [...ids].map((id) =>
                this.#serialize(id, async () => {
                    if (this.#failures.has(id)) await this.#read(id);
                    this.#abortInvocations(id);
                    await this.#stopRuntime(id);
                })
            ),
        );
        const failures = results.filter((result) =>
            result.status === "rejected"
        ).map((result) => result.reason);
        if (failures.length) {
            throw new AggregateError(failures, "plugin shutdown failed");
        }
    }

    /** Invoke an active runtime without exposing runtime instances to callers. */
    async invoke(
        id: string,
        invocation: PluginInvocation,
    ): Promise<Awaited<ReturnType<PluginRuntime["invoke"]>>> {
        this.#assertOpen();
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

    #runtimeFailed(id: string, state: RuntimeState, error: Error): void {
        if (
            this.#runtimes.get(id) !== state ||
            this.#failures.get(id)?.state === state
        ) return;
        state.active = false;
        const failure = { state, error };
        this.#failures.set(id, failure);
        this.#abortInvocations(id);
        this.#serialize(id, async () => {
            if (this.#failures.get(id) === failure) await this.#read(id);
        }).catch(() => {
            // Keep the failure until durable reconciliation succeeds.
            // Subsequent reads retry and can never report it healthy.
        });
        // A dependent can no longer execute under the contract it was enabled
        // with. Quarantine that branch; unrelated runtimes remain available.
        for (const [dependent, candidate] of this.#runtimes) {
            if (candidate.dependencies.includes(id)) {
                this.#runtimeFailed(
                    dependent,
                    candidate,
                    new Error(
                        `dependency_unavailable: plugin ${id} runtime failed`,
                    ),
                );
            }
        }
    }

    async #stopRuntime(id: string): Promise<void> {
        const state = this.#runtimes.get(id);
        if (state === undefined) return;
        state.active = false;
        state.unsubscribe?.();
        state.unsubscribe = undefined;
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
        return this.#serializeMany([id], operation);
    }

    #serializeMany<T>(
        ids: readonly string[],
        operation: () => Promise<T>,
    ): Promise<T> {
        return this.#schedule(() => Promise.resolve(ids), operation);
    }

    #schedule<T>(
        ids: () => Promise<readonly string[]>,
        operation: () => Promise<T>,
    ): Promise<T> {
        // Preserve call order while resolving lock keys, without waiting for runtime startup.
        const admission = this.#admissions.then(async () => ({
            result: this.#enqueue(await ids(), operation),
        }));
        this.#admissions = admission.then(() => {}, () => {});
        return admission.then(({ result }) => result);
    }

    #enqueue<T>(
        ids: readonly string[],
        operation: () => Promise<T>,
    ): Promise<T> {
        const keys = [...new Set(ids)];
        const previous = Promise.all(
            keys.map((id) => this.#operations.get(id)),
        );
        const result = previous.then(operation);
        result.catch(() => {});
        // A rejected operation must not poison later enable/disable attempts.
        const settled = result.then(() => {}, () => {});
        for (const id of keys) this.#operations.set(id, settled);
        settled.then(() => {
            for (const id of keys) {
                if (this.#operations.get(id) === settled) {
                    this.#operations.delete(id);
                }
            }
        });
        return result;
    }

    async #withDependencies<T>(
        id: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        let dependencies: readonly string[] = [];
        const result = await this.#schedule(async () => {
            dependencies = (await this.#store.get(id))?.manifest.dependencies ??
                [];
            return [id, ...dependencies];
        }, async () => {
            const current = await this.#store.get(id);
            if (
                (current?.manifest.dependencies ?? []).some((dependency) =>
                    !dependencies.includes(dependency)
                )
            ) {
                return { retry: true as const };
            }
            return { retry: false as const, value: await operation() };
        });
        return result.retry
            ? this.#withDependencies(id, operation)
            : result.value;
    }

    async #requireDependencies(record: PluginRecord): Promise<void> {
        const external = new Map(
            this.#externalDependencies().map((
                item,
            ) => [item.manifest.id, item]),
        );
        for (const id of record.manifest.dependencies ?? []) {
            const installed = await this.#store.get(id);
            const dependency = installed ?? external.get(id);
            const runtimeMissing = installed !== undefined &&
                (installed.isolated || this.#requireRuntimeOnEnable ||
                    this.#runtimeFactory !== undefined) &&
                !this.#runtimeActive(id);
            if (!dependency?.enabled || runtimeMissing) {
                throw lifecycleError(
                    "dependency_unavailable",
                    record.manifest.id,
                    `requires enabled dependency ${id}`,
                );
            }
        }
    }

    async #requireNoDependents(
        id: string,
        onlyEnabled: boolean,
    ): Promise<void> {
        const records = [
            ...await this.#store.list(),
            ...this.#externalDependencies(),
        ];
        const dependents = records.filter((record) =>
            (!onlyEnabled || record.enabled) &&
            record.manifest.dependencies?.includes(id)
        );
        if (dependents.length) {
            throw lifecycleError(
                "dependency_in_use",
                id,
                `is required by ${
                    dependents.map((record) => record.manifest.id).join(", ")
                }`,
            );
        }
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
        // Shutdown intentionally preserves the next process's enable preference.
        if (this.#closed && !this.#failures.has(id)) return record;
        return record === undefined ? undefined : await this.#reconcile(record);
    }

    async #reconcile(record: PluginRecord): Promise<PluginRecord> {
        const id = record.manifest.id;
        const failure = this.#failures.get(id);
        const requiresRuntime = record.isolated ||
            this.#requireRuntimeOnEnable ||
            this.#runtimeFactory !== undefined;
        if (
            failure === undefined && (!record.enabled || !requiresRuntime ||
                this.#runtimeActive(id))
        ) return record;
        const stale: PluginRecord = Object.freeze({
            ...record,
            enabled: false,
            updatedAt: this.#now(),
            lastError: failure === undefined
                ? "runtime_required: plugin runtime is not active"
                : `runtime_failed: ${failure.error.message}`,
        });
        this.#abortInvocations(id);
        // Failed storage must not keep a dead worker's registrations or resources.
        try {
            await this.#store.put(stale);
        } finally {
            await this.#stopRuntime(id);
        }
        if (this.#failures.get(id) === failure) this.#failures.delete(id);
        return (await this.#store.get(id)) ?? stale;
    }

    #runtimeActive(id: string): boolean {
        const state = this.#runtimes.get(id);
        return state?.active === true && state.runtime.isActive?.() !== false;
    }

    #assertOpen(): void {
        if (this.#closed) {
            throw new PluginLifecycleError(
                "policy_denied",
                "plugin host is closed",
            );
        }
    }
}

export function createPluginHost(
    options: PluginHostOptions = {},
): InMemoryPluginHost {
    return new InMemoryPluginHost(options);
}

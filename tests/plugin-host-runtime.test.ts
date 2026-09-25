import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
    computePluginArtifactDigest,
    createPluginHost,
    createPluginSignaturePayload,
    encodeBase64Url,
    InMemoryPluginHost,
    InMemoryPluginRecordStore,
    type PluginArtifact,
    PluginLifecycleError,
    type PluginRuntime,
    PluginVerificationError,
    validatePluginManifest,
    verifyPluginArtifact,
} from "../packages/plugin-host/mod.ts";

const encoder = new TextEncoder();

const isolatedManifest = {
    id: "example.echo",
    version: "1.2.3",
    apiVersion: "1",
    name: "Example Echo",
    kind: "protocol",
    trust: "isolated",
    routes: [{ method: "POST", path: "/v1/echo", operation: "echo.generate" }],
    permissions: { network: false, filesystem: "none", subprocess: false },
} as const;

const artifact: PluginArtifact = {
    manifest: isolatedManifest,
    entrypoint: "mod.ts",
    bytes: encoder.encode("export const plugin = true;\n"),
};

Deno.test("plugin host validates manifests and applies safe permission defaults", () => {
    const manifest = validatePluginManifest({
        id: "example.default",
        version: "0.1.0",
        apiVersion: "1",
        name: "Default",
        kind: "api",
    });
    assertEquals(manifest.trust, "isolated");
    assertEquals(manifest.permissions, {
        network: false,
        filesystem: "none",
        subprocess: false,
    });
    assertThrows(
        () => validatePluginManifest({ ...isolatedManifest, unknown: true }),
        PluginVerificationError,
    );
    assertThrows(
        () =>
            validatePluginManifest({
                ...isolatedManifest,
                routes: [{ method: "POST", path: "/../x", operation: "x" }],
            }),
        PluginVerificationError,
    );
    assertThrows(
        () =>
            validatePluginManifest({
                ...isolatedManifest,
                routes: [{
                    method: "POST",
                    path: "/v1/plugin/:id",
                    operation: "x",
                }],
            }),
        PluginVerificationError,
    );
    assertThrows(
        () =>
            validatePluginManifest({
                ...isolatedManifest,
                routes: [{
                    method: "POST",
                    path: "/v1/plugin/*",
                    operation: "x",
                }],
            }),
        PluginVerificationError,
    );
});

Deno.test("third-party verification fails closed for unsigned or over-privileged artifacts", async () => {
    const unsigned = await assertRejects(
        () => verifyPluginArtifact(artifact),
        PluginVerificationError,
    );
    assertEquals(unsigned.code, "unsigned_package");

    const networkArtifact: PluginArtifact = {
        ...artifact,
        manifest: {
            ...isolatedManifest,
            id: "example.network",
            permissions: {
                network: true,
                filesystem: "none",
                subprocess: false,
            },
        },
    };
    const denied = await assertRejects(
        () => verifyPluginArtifact(networkArtifact, { allowUnsigned: true }),
        PluginVerificationError,
    );
    assertEquals(denied.code, "permission_denied");
});

Deno.test("trusted publisher signatures verify the artifact digest", async () => {
    const keys = await crypto.subtle.generateKey(
        "Ed25519",
        true,
        ["sign", "verify"],
    ) as CryptoKeyPair;
    const digest = await computePluginArtifactDigest(artifact.bytes!);
    const signature = new Uint8Array(
        await crypto.subtle.sign(
            "Ed25519",
            keys.privateKey,
            createPluginSignaturePayload(digest) as BufferSource,
        ),
    );
    const raw = new Uint8Array(
        await crypto.subtle.exportKey("raw", keys.publicKey),
    );
    const verified = await verifyPluginArtifact({
        ...artifact,
        digest,
        signature,
        signerKeyId: "publisher.test",
    }, {
        trustedSigners: [{ keyId: "publisher.test", publicKey: raw }],
    });
    assertEquals(verified.status, "verified");
    assertEquals(verified.digest, digest);
    assertEquals(verified.signerKeyId, "publisher.test");
    assertEquals(encodeBase64Url(signature).includes("="), false);
});

Deno.test("in-memory host persists install state and activates a runtime", async () => {
    const calls: string[] = [];
    const runtime: PluginRuntime = {
        start() {
            calls.push("start");
            return Promise.resolve();
        },
        invoke(invocation) {
            calls.push(`invoke:${invocation.method}`);
            return Promise.resolve({ ok: true });
        },
        stop() {
            calls.push("stop");
            return Promise.resolve();
        },
    };
    const host = new InMemoryPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () => runtime,
        now: (() => {
            let index = 0;
            return () => `2026-01-01T00:00:0${index++}.000Z`;
        })(),
    });
    const installed = await host.install(artifact);
    assertEquals(installed.enabled, false);
    const enabled = await host.enable(artifact.manifest.id);
    assertEquals(enabled.enabled, true);
    assertEquals(await host.invoke(artifact.manifest.id, { method: "ping" }), {
        ok: true,
    });
    const disabled = await host.disable(artifact.manifest.id);
    assertEquals(disabled.enabled, false);
    assertEquals(calls, ["start", "invoke:ping", "stop"]);
    assertEquals(await host.uninstall(artifact.manifest.id), true);
    assertEquals(await host.get(artifact.manifest.id), undefined);
});

Deno.test("host rejects duplicate installs and required-runtime activation without a factory", async () => {
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        requireRuntimeOnEnable: true,
    });
    await host.install(artifact);
    const duplicate = await assertRejects(
        () => host.install(artifact),
        PluginLifecycleError,
    );
    assertEquals(duplicate.code, "already_installed");
    const missingRuntime = await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
    );
    assertEquals(missingRuntime.code, "runtime_required");
});

Deno.test("host requires an explicit built-in allowlist for trusted execution", async () => {
    const trusted: PluginArtifact = {
        ...artifact,
        manifest: {
            ...isolatedManifest,
            id: "heimdall.builtin",
            trust: "trusted",
        },
    };
    const host = createPluginHost({
        policy: { source: "builtin", trustedBuiltinIds: [trusted.manifest.id] },
    });
    await host.install(trusted);
    const enabled = await host.enable(trusted.manifest.id);
    assertEquals(enabled.enabled, true);
});

Deno.test("host stops a runtime that fails during startup", async () => {
    const calls: string[] = [];
    const host = createPluginHost({
        policy: { allowUnsigned: true },
        runtimeFactory: () => ({
            start() {
                calls.push("start");
                return Promise.reject(new Error("child failed"));
            },
            invoke() {
                return Promise.resolve(undefined);
            },
            stop() {
                calls.push("stop");
                return Promise.resolve();
            },
        }),
    });
    await host.install(artifact);
    const error = await assertRejects(
        () => host.enable(artifact.manifest.id),
        PluginLifecycleError,
    );
    assertEquals(error.code, "runtime_failed");
    assertEquals(calls, ["start", "stop"]);
    assertEquals((await host.get(artifact.manifest.id))?.enabled, false);
});

Deno.test("host fails closed when durable enabled state has no runtime", async () => {
    const store = new InMemoryPluginRecordStore();
    await store.put({
        manifest: isolatedManifest,
        enabled: true,
        isolated: true,
        updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const host = createPluginHost({
        store,
        policy: { allowUnsigned: true },
    });
    const error = await assertRejects(
        () => host.enable(isolatedManifest.id),
        PluginLifecycleError,
    );
    assertEquals(error.code, "runtime_required");
});

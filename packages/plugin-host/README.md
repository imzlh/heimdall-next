# `@heimdall/plugin-host`

This package is the host boundary for plugin verification, lifecycle, and
runtime isolation. It models package artifacts and invocations without choosing
a subprocess mechanism or importing plugin code.

Verification may persist a signed snapshot before execution is enabled. The
composition root decides whether a trusted built-in runs in process or an
isolated plugin uses an RPC runtime. Plugin implementations depend on public
HIP/contracts; they do not import this host package.

The package also ships a small runtime-neutral implementation:

- `validatePluginManifest` normalizes identity, routes, capabilities, and
  fail-closed permission defaults.
- `DefaultPluginVerifier` checks trust allowlists, permission ceilings, byte
  digests, and optional Ed25519 publisher signatures without evaluating the
  entrypoint.
- `InMemoryPluginHost` persists install/enable state through the
  `PluginRecordStore` port and starts/stops an injected `PluginRuntime`.

`InMemoryPluginRecordStore` is intended for local startup and tests. The server
composition root can replace it with a KV or SQLite adapter while retaining the
same lifecycle contract. No implementation in this package imports Deno, Hono,
Node or server implementation.

Lifecycle operations serialize per plugin identity; unrelated plugins remain
independent. Invocation admission shares that ordering, but active calls do not
hold the lifecycle queue. Disabling first persists the disabled state, then
cancels calls and stops the runtime. A rejected write preserves the running
instance; a rejected stop retains its reference for cleanup before a later
start. Uninstall retains the verified artifact until durable deletion succeeds.
Caller cancellation releases both queued and active invocation waits, even if
the runtime ignores its signal. Artifact bytes are snapshotted before async
verification and copied again at the runtime boundary.

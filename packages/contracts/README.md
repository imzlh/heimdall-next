# `@heimdall/contracts`

This package is the dependency direction boundary for heimdall-next.

- HIP v1 values and stream event declarations live in `packages/hip`.
- `plugin.ts` contains protocol, source, middleware, API, and preset plugin
  contracts.
- `storage.ts` contains storage value shapes. Runtime storage ports belong to
  `packages/storage`.
- `mod.ts` is the only public barrel entry point.

The package has no imports from `src/`, `plugins/`, Hono, Vue, SQLite, or Deno
KV implementations. Server code may implement these contracts; plugin packages
may depend on this package without importing server internals. Runtime reducers,
validation, registries, and error classes remain owned by the server boundary.

Use the Deno import-map alias:

```ts
import type { OperationRequest, ProtocolPlugin } from "@heimdall/contracts";
```

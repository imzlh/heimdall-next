# `@heimdall/hip`

HIP is Heimdall's transport-neutral execution boundary. This package owns the
canonical value shapes and pure service ports for `OperationRequest`, ordered
`StreamFrame` values, lifecycle state, cancellation, tools, reasoning, errors,
validation, reduction, hashing, and codecs.

Protocol adapters translate their wire format into `OperationRequest` values;
the standard message-generation payload is `GenerationRequest`. Source adapters
emit `StreamFrame` values and acknowledge cancellation with `run.cancelled`
after a `CancelRequest` or `run.cancel.requested` intent. HTTP servers, storage
adapters, provider SDKs, and plugin loading do not belong here.

`@heimdall/contracts` re-exports this module for plugin consumers. Keeping one
source of truth prevents the kernel and plugins from silently adopting different
HIP shapes.

The current entry point is `mod.ts`. It has no dependency on Deno, Node, Hono,
Vue, the filesystem, or server implementation.

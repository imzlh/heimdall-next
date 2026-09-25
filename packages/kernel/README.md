# `@heimdall/kernel`

The kernel package owns the transport-neutral execution runtime. It consumes an
`OperationRequest`, selects an inference source, and exposes ordered HIP frames
to the composition root while notifying lifecycle ports and observers.

Protocol route matching stays in the transport host. `ProtocolRegistry` is
exported as a separate registry for that host; `KernelRuntime` does not receive
or retain a protocol router. This keeps wire matching and semantic execution
independently replaceable.

`SourceRegistry` chooses compatible sources and validates their frame streams.
`MiddlewareRegistry` applies ordered request/frame transforms. The optional
`LifecycleHookRegistry` receives begin, frame, completion, and error callbacks
for recording, metrics, and tracing. The package imports no Hono, Deno KV,
SQLite, Vue, or server implementation.

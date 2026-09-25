# Plugin Contracts

Plugins are adapters around the kernel. They are not a second application
framework and they do not share private implementation modules.

## Package shape

Each plugin has a small mod.ts entry point. Keep implementation concerns in
focused modules so that parsing, transport, policy, and serialization can be
tested independently:

```text
protocol-*/
  mod.ts
  manifest.json
  input.ts       wire request parsing
  output.ts      non-stream response serialization
  stream.ts      SSE/frame serialization
  shared.ts      protocol-local types and helpers
source-*/
  mod.ts
  config.ts
  request.ts
  transport.ts
  response.ts
  errors.ts
preset-*/
  mod.ts
  schema.ts
  mapping.ts
  redaction.ts
```

## Protocol

A protocol plugin owns declared HTTP routes and wire serialization. It parses a
request into HIP OperationRequest values and serializes HIP StreamFrame values
back to JSON or SSE. It does not perform upstream I/O or access storage.

The initial protocol adapters are OpenAI Chat Completions/Responses and
Anthropic Messages. They share one HIP execution path while preserving their
native response shapes.

The OpenAI implementation follows the package shape above: `contract.ts` owns
route and dialect constants, `request.ts` parses inbound JSON, `response.ts`
builds non-streaming output, `stream.ts` maps HIP events to SSE, and
`serializer.ts` coordinates JSON/SSE lifecycle. `mod.ts` stays a small
host-facing entry point.

## Source

A source plugin advertises operation, model, streaming, and feature
capabilities. It receives a HIP request, performs provider I/O, and emits one
ordered HIP stream. Provider errors are converted to the canonical source error
before they reach the kernel.

The OpenAI-compatible source is an adapter, not the HTTP host. Its transport
module owns fetch and cancellation; request and response modules own wire
conversion; config owns validation and secret access.

## Middleware and API

Middleware plugins are ordered request and HIP stream transforms. The host
validates the result after every transform and preserves the request ID.

API plugins own exact method/path routes. Registration rejects conflicts before
the server starts. API handlers receive a scoped request context and return
serializable responses; they do not mutate Hono internals.

## Presets

A preset is a pure configuration factory. It validates input, maps it to a
source configuration, and returns a redacted preview. Applying a preset uses the
source configuration store's compare-and-set operation. The preset's server
mapping never makes network calls. A separately approved `ui.tsx` may render
inside the host's add-channel dialog and perform a provider authorization flow
through an exact authenticated management route. For example, the ChatHub preset
uses the existing cookie bridge for its API plugin's PKCE login, then submits
configuration through the host's JSON save/preview events.

## Trust and lifecycle

Package verification and execution are separate operations. The host validates
manifest, path, size, digest, and signature, then stores immutable bytes. A
stored package is never imported or evaluated automatically.

Trusted in-process execution requires a host allowlist and a registered runtime.
Third-party packages use an isolated broker with explicit RPC capabilities.
Enable/disable state is persisted independently of package bytes, so a failed
runtime cannot silently become active.

## UI plugins

Operator UI extensions default to host-rendered schemas. Reviewed modules may
mount in the host DOM; untrusted modules use a sandboxed iframe and a versioned
JSON bridge. Context contains only host-projected public status, never KV,
SQLite, administrator credentials, or kernel references. Trusted preset forms
can hold newly entered provider credentials in memory until save or unmount;
they never persist browser drafts or expose saved credentials in initial HTML.

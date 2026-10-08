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

### Per-source model mapping

`modelMap` is source-instance metadata owned by the host, alongside `name`,
`priority`, and `proxy`. It does not belong in a provider's raw `config` or its
schema form:

```json
{
    "name": "推理渠道",
    "priority": 10,
    "modelMap": { "public-model": "vendor-model-2026" },
    "config": { "baseUrl": "https://provider.example/v1" }
}
```

The core applies exactly one mapping before execution. Source adapters read
`request.traits.model` as the effective upstream model; they do not remap it or
prefer the original `payload.model`. The original payload, request identity,
metadata and cancellation context stay intact. Public protocol responses and
`run.started` records keep the caller's model name. The same mapping projects
advertised capabilities and probe results, replacing mapped upstream names with
their public aliases while retaining unrelated models.

The add/edit dialog owns the mapping rows. Preset JSX may suggest mappings
through the host's separate `modelMap` field, but cannot store them in provider
configuration. Existing `config.modelMap` documents migrate into host metadata
before provider or preset validation. An empty mapping clears aliases; updates
use the source revision and preserve active provider sessions. Names are
trimmed, limited to 256 characters and cannot contain whitespace/control
characters; each source supports up to 256 mappings and rejects duplicate public
names.

Invalid persisted mappings, including legacy fields on a disabled source, are
isolated per source during startup. The original record remains durable and
visible with `configurationErrorField: "modelMap"`; it cannot be routed until an
operator explicitly saves a replacement or empty mapping with the current
revision. Other metadata edits and provider-config saves cannot silently clear
this error. Invalid provider configuration is likewise preserved and identified
as `configurationErrorField: "config"`, allowing repair through the normal
configuration form. A failed revision check leaves both storage and routing
state unchanged. These recovery paths are covered by
`tests/source-restoration-errors.test.ts`.

The implementation is in `src/composition/source-model-mapping.ts`; the shared
JSON validator is `packages/admin-contracts/source-model-map.ts`. Routing,
upstream requests, public responses, migration and restart coverage is in
`tests/source-model-mapping.test.ts`.

### Outbound proxy preference

Source factories receive an optional `SourceFactoryOptions.getProxy()` callback.
Read it when starting network work to obtain the current, JSON-serializable
preference. It resolves a channel's `inherit`, `direct`, or explicit `proxyId`
choice against the global proxy pool. A selected entry that was removed or
disabled resolves to `unavailable`; credentials are included only in this
server-side plugin snapshot. Neither the raw provider config nor browser UI
contexts contain proxy credentials.

The host supplies configuration only. It does not replace `fetch`, set process
proxy environment variables, or enforce how trusted plugins connect. A plugin
can use its own transport, ignore the preference, or opt into the Deno helper:

```ts
import { SourceTransport } from "@heimdall/source-sdk";

// Inside an asynchronous provider operation; keep this scope open until its
// response body or stream has been fully consumed.
await using transport = new SourceTransport({
    getProxy: options.getProxy,
    signal,
});
const response = await transport.fetch(providerUrl, requestInit);
const data = await response.json();
```

The helper uses a pinned, locally cached Undici dependency for HTTP/TLS and
WebSocket transport. It owns and closes its clients, cancels active requests on
disposal, and rejects an unavailable selection. Explicit direct connections
bypass Deno's environment proxy discovery. Automatic redirects are disabled;
providers that need them must validate and request each new destination
explicitly. Use `transport.redactError()` before returning upstream diagnostics.
OpenAI, Anthropic and ChatHub adapters opt into this helper. Pool and channel
edits affect subsequent operations without destroying active plugin sessions.

API plugins that perform setup or authorization I/O receive an optional
`ApiRequestContext.resolveProxy(selection)` hook. Preset JSX sends only the
serializable selection to its authenticated API route; it never receives the
resolved credentials. The ChatHub authorization plugin uses this path.

## Middleware and API

Middleware plugins are ordered request and HIP stream transforms. The host
validates the result after every transform and preserves the request ID.

Trusted middleware is loaded by the server composition. Its enabled state is
durable, and the same kernel path serves every protocol and Chat. Each source's
basic configuration can choose its own chain using host-owned `middleware`
metadata:

| Value                               | Meaning                                      |
| ----------------------------------- | -------------------------------------------- |
| `null` or omitted                   | Inherit the enabled global chain             |
| `[]`                                | Apply no middleware to this source           |
| `["plugin.first", "plugin.second"]` | Use the selected plugins in this exact order |

The add/edit dialog owns this selection; provider schemas do not. Bindings are
validated before the durable write, use the source revision for conflicts, and
survive provider-config edits and restart. Globally disabling a plugin keeps its
source bindings but removes it from subsequent execution. Missing directory
plugins keep their saved bindings as well; a source binding never enables a
plugin on its own. A malformed persisted binding quarantines that source with a
repairable catalog error instead of using an unintended chain.

Each request holds an immutable snapshot of active middleware and source
bindings. A failover attempt gets its own input and model mapping, so mutations
made for the previous source cannot carry over. Middleware failures are
distinguished from upstream failures and do not cool down or retry the source.
Cancellation and transform failures close intermediate wrappers and the upstream
stream, including a wrapper returned after cancellation.

`tests/source-middleware.test.ts` covers directory loading, production server
execution, management changes, revision conflicts and reopening the durable
store. `tests/kernel-source-middleware.test.ts` covers order, failover
isolation, snapshot consistency, errors and cancellation;
`tests/chat-middleware.test.ts` covers the shared Chat path. Dynamic
installation of middleware packages remains separate from this
reviewed-directory lifecycle.

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

### Offline managed tool packages

The management page can install `heimdall-plugin/v1` JSON packages. The current
runtime supports `kind: "tool"`, `trust: "isolated"` packages with one bundled
ESM entrypoint. Source, preset, protocol, API and UI plugins continue to use the
reviewed server composition; uploading one of these kinds is rejected. An
installed tool package can already contribute declarative UI through its
manifest's `ui` array. This does not install executable browser assets or grant
trusted-module permissions.

An isolated entrypoint exports `invoke(method, payload, context)`:

```js
export function invoke(method, payload) {
    if (method === "tools.list") {
        return [{
            name: "text_length",
            description: "返回文本字符数",
            inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
            },
        }];
    }
    if (method === "tools.execute") {
        const args = JSON.parse(payload.argumentsText);
        return { text: String([...String(args.text)].length), isError: false };
    }
    throw new Error("Unknown method");
}
```

Use a manifest such as:

```json
{
    "id": "example.text-length",
    "name": "文本长度",
    "version": "1.0.0",
    "apiVersion": "1",
    "kind": "tool",
    "trust": "isolated"
}
```

Bundle TypeScript and dependencies before packaging, then produce the JSON
artifact with the existing verifier and SHA-256 implementation:

```sh
deno bundle --node-modules-dir=none --platform browser --minify --output plugin.js plugin.ts
deno task plugin:package manifest.json plugin.js text-length.heimdall.json
```

For a self-contained JavaScript module, only the second command is needed.
Packaging reads files without evaluating the entrypoint, checks the manifest and
permission policy, and refuses to overwrite an existing output. The code limit
is 1 MiB and the complete JSON file limit is 2 MiB. Upload the resulting file
through **总览 → 插件能力 → 安装插件**, review its metadata, then enable its
card. Installation verifies the digest on the server and persists the package in
KV; it does not grant execution until enabled. Enabled packages are reverified
and restored when the server restarts.

The worker receives JSON values and an abort signal. Network, filesystem,
environment and subprocess access are denied; no runtime package downloads are
performed. A checksum verifies artifact integrity, not publisher identity.

## UI plugins

Operator UI extensions default to host-rendered schemas. Reviewed modules may
mount in the host DOM; untrusted modules use a sandboxed iframe and a versioned
JSON bridge. Context contains only host-projected public status, never KV,
SQLite, administrator credentials, or kernel references. Trusted preset forms
can hold newly entered provider credentials in memory until save or unmount;
they never persist browser drafts or expose saved credentials in initial HTML.

The available named slots are:

| Slot               | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `dashboard.widget` | Overview cards and metrics                        |
| `source.status`    | Status for the exact declared `sourcePluginId`    |
| `settings.section` | A settings section                                |
| `nav.tab`          | A top-level navigation destination                |
| `chat.composer`    | Compact capability controls above the Chat input  |
| `chat.sidebar`     | Plugin status or help in the conversation sidebar |

Enabled managed tool manifests join the same live UI catalog as reviewed local
manifests. Disabling or uninstalling a package withdraws its declarations;
restart restores enabled declarations. Invalid or conflicting declarations are
isolated to their package. The host policy must approve the exact contribution
and self-hosted asset path before `trusted` or `sandbox` rendering is used;
otherwise the required schema fallback renders. Declaring trust in a manifest
never grants execution by itself.

### Chat slots

Chat owns conversation and capability state; plugins own their business UI. Web
search declares its own input toggle and sidebar description in
`plugins/tool-web/manifest.json`. A tool without a `chat.composer` declaration
receives a generic host-rendered conversation toggle. Account quota belongs to
the provider's account module and `source.status`, not the Chat kernel.

For example, add this contribution to a tool manifest's `ui` array:

```json
{
    "pluginId": "example.text-length",
    "id": "capability",
    "slot": "chat.composer",
    "title": "文本长度",
    "schema": {
        "blocks": [{
            "kind": "toggle",
            "label": "文本长度",
            "checked": true,
            "checkedFrom": ["tool", "enabled"],
            "disabledFrom": ["chat", "busy"],
            "action": { "id": "chat.tool.toggle", "payload": {} }
        }]
    }
}
```

Every contribution receives JSON context with the current conversation ID,
locale/theme, public model, message count, busy state, and its own tool's
enabled state. It does not receive message text, prompts, drafts, attachments,
credentials or another plugin's private state. Bindings are property paths into
`context.data`, not executable expressions. Schema content remains readable
during SSR; interactive controls become available in the Chat island.

The current Chat action is `chat.tool.toggle`. The host appends a boolean
`checked`, binds the target to the declaring plugin, and rejects arbitrary
actions, extra payload fields and stale conversation contexts. A new
conversation keeps pending tool choices until creation; existing conversations
persist them as `disabledTools`. Declaring an action does not create a new API
capability.

Tool projection and conversation selection share `MAX_CHAT_TOOLS = 128` and
`parseChatDisabledTools` from `packages/admin-contracts/chat.ts`. Counts apply
after filtering the mixed plugin catalog. All presented tools can be disabled
together before the first send; API saves, SQLite reopening, forks and SSR
preserve the full choice. Overflow is rejected rather than truncated, since
dropping a disabled ID would enable a tool unexpectedly.

One subscription per Chat island refreshes `/admin/chat/ui` on plugin catalog
events, focus/visibility changes and every 30 seconds while visible. Cross-tab
changes use the catalog storage event. A refresh replaces tool metadata and
unmounts removed contributions; disposal aborts pending reads and removes
listeners. The endpoint requires a same-origin management session. A 401 removes
the rendered capabilities and their cache signature; successful reauthentication
restores them even if the catalog itself has not changed. Both slots remain
mounted when the SSR page is enhanced into the interactive `ChatApp`.

Keep composer contributions short: the host allocates a scrolling row up to 720
px wide and 116 px high, with individual surfaces capped at 320 px by 104 px.
Sidebar contributions use the sidebar width, 10 px by 12 px padding and a 240 px
per-card height cap; the group scrolls within 28 viewport-height units. Use the
host color/spacing tokens and internal scrolling rather than expanding the page.
Toggle animation respects reduced-motion preferences.

The JSON contract is in `packages/admin-contracts/chat-ui.ts`; SSR and DOM,
conversation rebinding, action authorization and dynamic removal are covered by
`tests/web/chat-slots.test.tsx`. `tests/managed-plugin-ui.test.ts` covers
installed manifest UI, restart, disable/uninstall and trust fallback.

### Real-browser acceptance

Run `deno task test:browser` to build self-hosted assets and execute
`scripts/browser-smoke.ts` against an existing Chrome installation. Set
`HEIMDALL_BROWSER_EXECUTABLE` for a custom browser path. The pinned
`playwright-core@1.55.1` dependency belongs only to this acceptance script, not
to the application runtime or client bundle. It does not download a browser.

The script uses a local fixture upstream and independent in-memory KV/SQLite
stores, leaving operator databases untouched. Screenshots and diagnostic output
go into a dedicated temporary directory. Cache build and acceptance dependencies
before running offline. `deno task verify` and `deno task test:browser` are
separate checks; type and DOM tests do not imply successful browser acceptance.

On 2026-10-01, the final `deno task verify` completed with **1149 passed (129
steps), 0 failed**, including format, lint, type and build checks. The
independent browser run exited successfully on **Chrome 154.0.8037.58**, with
`success: true` and an empty `failures` list. It exercised in-dialog preset JSX,
local network probing and source saves, public/upstream model mapping, custom
schema forms, top-level model/middleware metadata, Escape, Chat slot enhancement
and persisted tool/model choices. An offline package was installed, enabled,
shown in both Chat slots, invoked through a real Worker, disabled across tabs,
and uninstalled.

Light/dark, 390 px layout without horizontal overflow, reduced-motion
screenshots and readable slots with JavaScript disabled were recorded. The
statistics chart's inline-width CSP violation was replaced with SVG attributes;
the final browser console had no errors. Results and screenshots are in
`%TEMP%/heimdall-browser-914bd909a72554df`; the full verification log is
`%TEMP%/heimdall-final-verify.txt`. External ChatHub account authorization,
actual Chinese IME input and physical touch devices were not exercised by this
run.

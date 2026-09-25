# Heimdall Next Architecture

Heimdall Next uses Deno, Hono, and Hono JSX as its application stack. The
gateway, management API, server-rendered console and Chat pages, and browser
assets are delivered by one Deno process. Server and browser code have explicit
import boundaries within the repository's `src` tree; Deno tasks build and
verify both environments. The root `main.ts` is the executable entry point.

## Runtime tree

```text
heimdall-next/
  main.ts                    Deno entry point
  src/
    http/                    Hono app, middleware, routes, SSE, errors
    composition/             host wiring and executable startup
    storage/                 KV and SQLite implementations
    stats/                   usage aggregation and calendar helpers
    chat/                    conversation orchestration and extension ports
    web/
      components/            server JSX shell and shared server components
      pages/                 server JSX console and Chat pages
      server/                session, snapshot, and UI request bridge
      shared/                environment-neutral UI schema data
      client/                browser JSX pages and HTTP/WebSocket clients
        main.tsx             operator console bundle entry point
        chat-main.tsx        standalone Chat bundle entry point
  public/assets/             generated JavaScript and CSS
  packages/
    hip/                     transport-free internal protocol
    contracts/               plugin and storage contracts
    kernel/                  routing and lifecycle
    storage/                 runtime-neutral storage ports
    plugin-host/             verification and isolated runtime ports
    admin-contracts/         serializable DTOs and browser-safe UI contracts
  plugins/
    *-protocol/              client wire adapters
    *-source/                upstream adapters
    *-preset/                configuration factories
    tool-*/                  model tool implementations
  scripts/                   Deno development and preview tools
  tests/                     the only test location, including .tsx tests
```

## Dependency direction

```text
entry point        -> composition -> HTTP, storage, kernel, plugin host
HTTP               -> kernel ports, plugin contracts, server JSX pages
server JSX pages   -> server JSX components
browser entries    -> interactive pages -> HTTP/WebSocket clients
HTTP + browser     -> admin-contracts
kernel/plugin host -> contracts -> HIP
backend plugins    -> contracts + HIP
plugin browser UI  -> Hono JSX DOM + browser-safe contracts and schema helpers
storage adapters   -> storage ports
```

`packages` must not import applications, concrete plugins, or Hono.
`packages/hip` has no HTTP, filesystem, Deno KV, SQLite, Hono, Node, or provider
imports. `packages/contracts` declares plugin capabilities and data contracts
without constructing a server. `packages/kernel` coordinates operations through
ports and never receives a Hono context. Server composition assembles concrete
implementations.

Hono imports belong in the HTTP and web presentation layers, including approved
plugin browser entry points. Backend plugin modules and domain code stay free of
Hono. Server pages and components use `hono/jsx`; browser pages use
`hono/jsx/dom`. Browser modules import local browser code, Hono JSX, and
browser-safe admin contracts. DTOs are type-only imports; explicitly shared
schema utilities are pure data transforms. Shared UI helpers must remain usable
without Deno, Node, or DOM globals. They cannot hide an import of either
environment's application code.

Browser modules cannot import server HTTP, composition, storage, kernel, backend
plugin implementations, Deno, or Node APIs. Server modules cannot import the
browser tree, including through type imports: pages reference generated assets
by URL.

## Web and HTTP boundary

The Hono host owns:

1. request IDs, body-size limits, and cancellation signals;
2. exact route registration and conflict detection;
3. bounded JSON parsing and schema validation;
4. SSE framing through Hono's streaming helpers;
5. stable error envelopes at the HTTP boundary;
6. server-rendered console pages and browser asset delivery.

`GET /admin` renders the operator shell and complete read-only page content on
the server. The browser entry uses Hono JSX DOM's `render` to replace the
`heimdall-console` region with one interactive console; the document and
navigation container are server-rendered. Forms, dialogs, refresh controls, and
plugin mounts run inside that region. This is a client mount, without
per-component hydration. If mounting fails, the browser entry restores the
read-only server snapshot. Server rendering accepts a serializable, redacted
snapshot through a host-owned port. Authorization applies to management data,
and credentials or storage handles must never enter page props, island context,
or HTML.

The management API's canonical namespace is `/api/admin/*`. Existing `/admin/*`
API aliases remain compatible, so console navigation does not introduce
conflicting page paths. `/admin/assets/*` is reserved for generated browser
assets and host-approved plugin UI files. The standalone Chat page is served at
`/admin/chat`; existing `/api/chat/*` endpoints remain compatible.

Protocol plugins provide route descriptors and wire codecs. The host turns a
validated request into a transport-neutral kernel request, then serializes HIP
frames through the selected protocol plugin. Protocol plugins do not call
upstreams.

Business API routes use explicit Hono registrations. Plugin manifests may not
declare `:` parameters or `*` wildcards. The host owns the plugin namespace and
asset delivery; application code does not scan URL strings to dispatch business
operations.

When an admin token is configured, the console signs in through
`POST /admin/session`, exchanging the admin credential for an eight-hour signed,
HttpOnly, SameSite=Strict cookie scoped to `/admin`, with `Secure` on HTTPS. The
cookie contains no admin credential. The executable owns a process-local signing
secret, so restarting invalidates sessions. SSR reads snapshots through the
management APIs. The browser console uses `POST /admin/ui/request`, a
same-origin UI bridge with an explicit path/method allowlist. It injects the
configured bearer internally and preserves response status, ETags, and request
IDs. It is not a general URL or plugin-route proxy. Login, logout, and bridge
requests reject cross-origin browser submissions; direct management APIs retain
bearer authentication. Without an admin token, the executable allows management
access without sign-in. No-JavaScript sign-in and read-only pages remain
available.

## Standalone Chat

`GET /admin/chat?id=...` renders a separate Chat document with a saved
conversation selected by `id`, a conversation list, available models, and a
return link to `/admin`. `src/web/server/chat-snapshot.ts` reads the existing
Chat and model APIs, projects bounded JSON presentation records, and never
passes a store handle or admin credential into page props. Unauthenticated
requests do not read protected history. The shared DTOs live in
`packages/admin-contracts/chat.ts`.

The Chat browser entry mounts one Hono JSX DOM region at `heimdall-chat` and
loads its own JavaScript and CSS. It is separate from `heimdall-console` and the
console bundle. Read-only history and navigation are server-rendered; sending,
image attachments, streamed replies, stopping, and regenerating require
JavaScript.

`/admin/chat/api/*` mounts the same exact Chat handlers as `/api/chat/*` through
a web-session boundary. HTTP writes and WebSocket upgrades additionally require
an Origin matching the page's origin. The adapter preserves the original request
for native WebSocket upgrades and adds `no-store` to HTTP responses. The browser
uses the HttpOnly session, with `/admin/chat/api/socket` carrying `send`,
`stop`, and `regenerate` commands; it does not serialize an admin token into
URLs or WebSocket subprotocols. Direct `/api/chat/*` clients retain their
existing authentication. The management bridge remains scoped to management
APIs.

Conversation creation, list/read, message generation, and regeneration use the
existing backend operations. `PATCH /conversation?id=...` renames a conversation
and `DELETE /conversation?id=...` removes it, through either authenticated Chat
entry point. These mutations share the generation lock and return 409 during
an active turn; SQLite deletes the conversation, messages, and attachments in
one transaction. The sidebar confirms deletion before issuing the request and
switches to an adjacent conversation after success. Failed mutations preserve
the selection, history, and in-memory draft; a failed history switch also leaves
the current conversation readable. Individual message deletion is not exposed.

The Chat core owns bounded history, generation, cancellation, and generic tool
orchestration. `packages/contracts/tools.ts` defines `ToolPlugin`, tool
definitions, invocation results, cancellation, and per-run budgets. Composition
supplies the tool provider; the core validates registration and bounds arguments
and results without recognizing special tool names. Clock and web-search/fetch
implementations live in `plugins/tool-clock` and `plugins/tool-web`. There are
no core web-search or memory exceptions; additional capabilities must enter
through plugins. No memory plugin is currently supplied.

## UI extension boundary

Source creation runs inside one dialog within the console island. Its content
changes from name and priority to preset/custom selection, then to the selected
preset's JSX or the host's schema form. No navigation or separate source setup
entry is involved. Going back preserves the base information and selection;
closing discards the in-memory draft and unmounts plugin content. Drafts and
provider secrets never enter URLs or browser storage. Successful creation closes
the dialog and refreshes the channel list. The source-create API persists display name,
priority, and owning plugin separately from provider configuration. Lower
priority values win source selection.

A preset may declare `presetPage.modulePath` and provide `plugins/<dir>/ui.tsx`.
The host mounts that JSX inside the dialog only when `UiPolicy.trustedModules["<presetId>:setup"]`
exactly matches the declared asset path. Composition adds the reviewed built-in
NewAPI setup module through `withBuiltinPresetPages`; other preset pages require
an explicit host policy entry. The plugin receives a validated JSON context and
emits bounded `preview` or `save` actions through the preset UI contract. The
host owns HTTP calls and feedback, and passes no admin credential to the module.
Custom setup uses the host's schema form after choosing a source plugin.

The host owns navigation, section layout, form controls, validation display,
loading/error states, and slot allocation. Plugin UI contributes through four
named slots: `dashboard.widget`, `source.status`, `settings.section`, and
`nav.tab`. Schema-driven rendering is the default. Trusted DOM extensions and
sandboxed iframe extensions are separate trust modes with explicit registration.

Extension contracts define serializable context and explicitly allowed host
actions, without exposing a Hono context, database, global application store, or
admin credentials. A backend plugin manifest is not permission to execute
arbitrary code in the console. The executable discovers `ui` contributions and
source/preset `configSchema` declarations from manifests.

`serve()` supplies loader functions for `adminUiContributions` and
`adminUiSchemas`. Authorized SSR and `GET /admin/ui/catalog` invoke them again
to read bounded, validated manifest JSON without importing plugin modules. The
catalog endpoint uses the existing session authorization check, accepting a web
session cookie or the configured admin bearer token, and checks same-origin
request context. It returns `{ contributions, schemas, sourcePluginIds, presetPages }` with
`Cache-Control: no-store` and limits the JSON snapshot to 4 MiB. Contributions
are filtered against the current runtime catalog's enabled plugins. Preset
module paths also require enabled preset/source plugins and an exact own entry
in the host's trusted-module policy; manifest declarations cannot grant trust.

The browser refreshes this catalog alongside management state when the operator
refreshes, saves a source, or completes a supported plugin lifecycle operation.
It updates form schemas, slots, source ownership, and the plugin links in the
server-rendered navigation container. There is no background polling or
WebSocket subscription. Manifest `ui` and `configSchema` edits for enabled
plugins take effect on refresh without a rebuild or restart. Adding backend
modules or changing runtime code requires restarting the executable; normal ESM
caching still applies. Host policy is loaded at startup and also requires a
restart to change.

The browser action callback is connected to `/admin/ui/action`, which rechecks
the live contribution, host allowlist, and source ownership before invoking a
registered handler. Embedders supply handlers through
`createServer({ adminUiActions })` or `serve({ adminUiActions })`; the default
executable registers no plugin-specific business handlers. `adminUiPolicy`
separately controls the allowed actions and executable UI assets.

The executable reads host policy from the JSON file named by
`HEIMDALL_UI_POLICY_PATH`; `src/composition/ui-policy.ts` validates its
`trustedModules`, `sandboxDocuments`, and `allowedActions` maps. Policy keys
name `pluginId:contributionId`. `src/http/admin-assets.ts` serves the generated
console bundle and only the exact plugin `.js` or `.html` paths declared by that
policy under `/admin/assets/plugins/`. Plugin files must resolve inside the
configured asset root. Sandboxed HTML receives a restrictive content security
policy; trusted DOM modules run in the console and require explicit operator
trust. Missing asset approval leaves the contribution on its schema fallback.

See [docs/operator-ui.md](docs/operator-ui.md) for the exact integration status
and a working schema registration example. Local assets and system fonts keep
the console independent of CDNs at runtime.

## HIP and plugin boundaries

HIP is the value protocol shared by protocol adapters, middleware, the kernel,
and source adapters. `packages/hip` owns its types and invariants.

- Protocol adapters decode requests into `OperationRequest`.
- Source adapters consume an operation and emit ordered `StreamFrame` values.
- The kernel validates every frame and owns lifecycle transitions.
- Protocol adapters encode the same frame stream as JSON or SSE.

Unknown provider fields stay in namespaced extensions. Secrets are stripped
before frames, logs, or persistent records are created.

Plugin `mod.ts` files expose small public entry points. Input, output, stream,
transport, validation, and redaction belong in focused modules. Keep ordinary
modules below roughly 300 lines; put large lookup tables in data modules. A
plugin extends behavior through declared contracts and cannot reach into host
implementation details or another plugin's private modules.

Third-party packages are verified and persisted as immutable snapshots before
activation. Verification never imports package code. Trusted in-process
execution requires an explicit host allowlist; otherwise an isolated runtime is
required. The built-in loader validates `manifest.json` and imports only trusted
entries. Isolated directory packages may be cataloged, but the default
executable does not configure a PluginHost `runtimeFactory` or Worker adapter
and exposes no package upload/install API. PluginHost provides lifecycle and
isolated runtime ports for an embedding host; live UI metadata refresh does not
install or reload backend code. Built-in source enable/disable updates the live
`SourceRegistry`; built-in protocol and preset plugins remain immutable.

## Storage boundary

The application is single-tenant. Deno KV stores control-plane state and
configuration under one namespace. SQLite stores request records, HIP frames,
usage, and chat data. Server-owned adapters implement ports from
`packages/storage`; the kernel depends on ports rather than KV or SQLite APIs.
`packages/storage` itself has no Deno KV or SQLite imports.

## Build and verification

`deno task prepare` caches dependencies from `main.ts` and every
`plugins/*/mod.ts` entry, then runs `deno task build:web`.
`scripts/build-web.ts` invokes Deno's bundler using `deno.browser.json` and the
entries from `scripts/web-build.ts`: the console, standalone Chat,
and preset-owned `ui.tsx` entries declared by manifest `presetPage.modulePath`.
The console emits `public/assets/console.js` and `console.css`; Chat emits
`chat.js` and `chat.css` from `src/web/client/chat-main.tsx` and its CSS
imports. Generated assets are deployment output. The server renders JSX pages
directly; there is no separate SSR build or Node package installation.

`deno task dev` completes preparation before supervising browser and server
watchers. `deno task start` completes preparation and starts the server;
`deno task serve` uses `--cached-only` with existing assets. Deployment includes
the server sources, packages, plugins, generated assets, and prepared Deno
cache, or performs preparation on the target before serving. An empty cache
requires initial dependency retrieval. Serving the prepared console needs no CDN
or dependency downloads; upstream calls and probes retain their network
requirements.

`deno task preview:ui` renders the server JSX components with console styles and
explicit sample data into self-contained
[light](docs/previews/operator-light.html) and
[dark](docs/previews/operator-dark.html) HTML previews. Their controls are
disabled and they load no browser console bundle. These artifacts support visual
review; they do not establish real browser interaction acceptance or exercise
live sessions, management APIs, or plugin execution.

`deno task preview:chat` separately renders `ChatShell` and `ChatPageView` into
[Chat light](docs/previews/chat-light.html) and
[Chat dark](docs/previews/chat-dark.html) previews. They use fixed sample
history, inline styles, disabled controls, and local anchors, with the same
visual-review limitations as the operator previews.

`deno task verify` covers formatting, linting, server and browser type checks,
tests, and the browser build. Browser checking uses DOM libraries without Deno
globals. `tests/architecture.test.ts` enforces dependency direction, Hono's
layer ownership, server/browser isolation, browser-safe shared contracts,
removal of the former admin application, and centralized TypeScript/JSX test
placement.

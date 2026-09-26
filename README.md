# heimdall-next

heimdall-next is a single-tenant TypeScript service built with **Deno, Hono, and
Hono JSX**. One Deno process serves the gateway, management APIs, operator
console, and standalone Chat page. One Deno task graph checks and builds the
application.

- `main.ts` and `src` form the composition root and HTTP host. Hono owns routes,
  middleware, request parsing, SSE, errors, and server-rendered JSX pages.
- `src/web` owns the console and Chat pages. Server components and pages use
  `hono/jsx`; browser pages use `hono/jsx/dom` and HTTP/WebSocket API clients.
- `packages` contains transport-free HIP, contracts, kernel behavior, storage
  ports, plugin-host interfaces, and browser-safe admin contracts.
- `plugins` contains protocol, source, preset, and tool implementations.
- `tests` is the only test tree, including JSX and browser-client tests.

The kernel exchanges HIP values. A protocol adapter turns a client request into
an `OperationRequest`; a source adapter executes it and emits ordered
`StreamFrame` values; the protocol adapter serializes those frames back to the
client. Provider names and wire objects stay outside the kernel.

## Repository layout

```text
heimdall-next/
  main.ts                 Deno entry point
  src/http/               Hono routes, middleware, SSE, and errors
  src/composition/        concrete registries, adapters, and startup wiring
  src/storage/            Deno KV and SQLite adapters
  src/stats/              usage aggregation and calendar helpers
  src/chat/               chat orchestration and tools
  src/web/
    components/           server-rendered JSX components
    pages/                server-rendered console and Chat pages
    server/               web session, snapshot, and request bridge
    shared/               environment-neutral UI schema data
    client/               browser JSX pages and HTTP/WebSocket clients
      main.tsx            operator console bundle entry point
      chat-main.tsx       standalone Chat bundle entry point
  public/assets/          generated page bundles, CSS, and plugin UI modules
  packages/
    hip/                  transport-free HIP types and invariants
    contracts/            plugin and storage contracts
    kernel/               routing and lifecycle
    storage/              runtime-neutral persistence ports
    plugin-host/          verification and isolated runtime ports
    admin-contracts/      HTTP DTOs and browser-safe UI/form contracts
  plugins/                protocol/source/preset/tool implementations
  scripts/                Deno development and preview tools
  tests/                  all Deno tests
```

The server renders complete read-only JSX pages directly. Hono JSX DOM then
mounts one interactive console in the `heimdall-console` region, replacing that
region's content while retaining the server-rendered document and navigation
container. It does not hydrate individual server components. Browser modules
reach live state through HTTP and cannot import server modules, storage handles,
or Deno APIs. Pages reference browser assets by URL without importing the
browser entry point.

## Run the application

Run these commands from `heimdall-next` with Deno 2.9 or newer:

```text
deno task dev
```

This prepares dependencies and browser assets before starting the web and server
watchers. Open `http://127.0.0.1:8088/admin` for the console. `HOST` defaults to
`127.0.0.1` and `PORT` defaults to `8088`.

For a local start without watchers:

```text
deno task start
```

For preparation followed by a separate serving step:

```text
deno task prepare
deno task serve
```

`prepare` caches dependencies from `main.ts` and each `plugins/*/mod.ts` entry,
then runs `build:web` with Deno's browser bundler. Console and Chat have
separate entries; Chat produces `public/assets/chat.js` and `chat.css`, while
the console produces `console.js` and `console.css`. The build also emits
browser modules declared by preset manifests. `start` runs preparation followed
by `serve`; `serve` uses `--cached-only` and the existing assets. Deploy the
server sources, packages, plugins, generated assets, and a prepared Deno
dependency cache. Run preparation on the target environment before serving if
its cache is empty. Deno is the only required build tool; no separate Node
package installation is needed.

The console is rendered at `/admin`, and its assets are served at
`/admin/assets/*`. Scripts, styles, and system fonts require no runtime CDN.
After preparation, serving the console needs no dependency downloads. The first
dependency retrieval and upstream provider calls still require their respective
network access.

Management clients use `/api/admin/*`. Existing `/admin/*` management API paths
remain compatibility aliases. New console pages must not shadow those aliases.
The existing `/api/chat/*` APIs remain available. Chat has its own page at
`/admin/chat`, with `/admin/chat?id=...` selecting a saved conversation and a
link back to `/admin`. The server renders the initial history and model
snapshot; a separate Hono JSX DOM entry adds conversation creation, model
selection, text and image messages, streaming, stop, and regeneration.
Conversations can be renamed or deleted through confirmation dialogs; active
generation blocks these edits. Assistant messages use locally bundled Marked
tokens and safe JSX for Markdown, tables, task lists, and copyable code blocks.
Chat uses its own browser bundle rather than loading the operator console
bundle.

The Chat page shares the operator's web session. Its HTTP calls and WebSocket
connection use `/admin/chat/api/*`, which mounts the existing Chat handlers
behind the session and same-origin checks. The management bridge at
`/admin/ui/request` continues to handle management operations. Without
JavaScript, the Chat page supports signing in, navigating saved conversations,
and reading the server snapshot.

The Chat core owns conversation history, generation, and cancellation.
Additional capabilities enter through plugin contracts: tool definitions and
execution come from `ToolPlugin`, with no search, webpage-fetching, clock, or
memory special cases in the core. Search/fetch and clock implementations live
under `plugins/tool-web` and `plugins/tool-clock`; no memory plugin is currently
supplied.

## Configuration and persistence

SQLite runtime data defaults to `data/`, which is ignored by git. Configure
`HEIMDALL_KV_PATH` to choose a control-plane database file; otherwise Deno
selects its default KV location. The executable discovers trusted built-in
plugins from `plugins/`, including protocol, source, preset, and tool adapters
whose manifests are present. Source configuration is stored in Deno KV and
updates the live source registry after a successful optimistic write.
`createServer()` remains available for tests and embedders; plugin loading and
persistent stores belong to the executable composition.

| Variable                                               | Purpose                                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `HEIMDALL_KV_PATH`                                     | Control-plane configuration database                                            |
| `HEIMDALL_REQUESTS_PATH`                               | Request, frame, and usage SQLite database; defaults to `./data/requests.sqlite` |
| `HEIMDALL_CHAT_PATH`                                   | Chat SQLite database; defaults to `./data/chat.sqlite`                          |
| `HEIMDALL_ADMIN_TOKEN`                                 | Bearer token protecting management and chat data                                |
| `HEIMDALL_OPENAI_BASE_URL` / `HEIMDALL_OPENAI_API_KEY` | Initial OpenAI-compatible source configuration                                  |
| `HEIMDALL_PROXY_KEY`                                   | Required bearer token or `x-api-key` for `/v1`                                  |
| `HEIMDALL_RATE_LIMIT`                                  | Requests per minute per peer; defaults to `120`, `0` disables the limit         |
| `HEIMDALL_PROBE_INTERVAL_MS`                           | Source probe interval; defaults to `300000`, `0` disables periodic probing      |
| `HEIMDALL_REQUEST_RETENTION_DAYS`                      | Prune journal requests older than this many days; defaults to `0` (keep all)    |
| `HEIMDALL_TIMEZONE`                                    | IANA zone whose calendar days bucket usage statistics; defaults to process zone |

Set `HEIMDALL_ADMIN_ASSETS` to serve built browser assets from a directory other
than `./public/assets`. Set `HEIMDALL_UI_POLICY_PATH` to a host-owned JSON
policy file declaring `trustedModules`, `sandboxDocuments`, and `allowedActions`
for plugin UI contributions. Composition includes the reviewed NewAPI setup
module; additional executable plugin pages and contribution assets require host
approval. Four-slot extension actions still require a registered host handler.

When `HEIMDALL_ADMIN_TOKEN` is configured, the console signs in through
`POST /admin/session`. It uses an HttpOnly, SameSite=Strict signed cookie scoped
to `/admin` and valid for eight hours, with `Secure` on HTTPS. The cookie
contains no admin token, and restarting the executable invalidates sessions.
Browser edits use the same-origin `/admin/ui/request` bridge, which forwards
only explicitly allowed management operations. Direct `/api/admin/*` and legacy
`/admin/*` API clients keep their bearer-token authentication.
`POST /admin/logout` clears the session. Without an admin token, the executable
allows management access without sign-in.

Without JavaScript, sign-in and server-rendered read-only snapshots remain
available. Interactive edits require JavaScript. Credentials are never
serialized into HTML or browser storage. Source secrets are write-only: an empty
API key preserves the stored key, and redacted responses expose only whether a
key is configured.

The proxy key, rate limit, and probe interval can be updated through
`PUT /api/admin/settings` without a restart; stored settings override the
environment. `/health` and console requests are not counted toward the proxy
rate limit. When periodic probing is enabled, sources that are enabled and
implement probing are checked on startup.

Outbound proxies are configured separately under **设置 → 出站代理池**. Add
HTTP, HTTPS or SOCKS5 endpoints, choose a global default, then select inherit,
direct or a specific proxy in each channel's dialog. `/api/admin/proxies`
exposes the versioned pool; credentials are write-only. The host gives plugins
the current selection through an optional `getProxy()` hook and does not enforce
network routing. Built-in sources adopt the optional transport SDK. See
[plugin contracts](docs/plugins.md#outbound-proxy-preference) for its boundary.
The outbound pool is unrelated to the gateway access `proxyKey` above.

Changing the probe interval reschedules background checks immediately; setting
it to zero cancels current checks. Manual and periodic probes share the same
timeout and request cancellation path. Late results from a replaced channel or
an older probe cannot overwrite current health or discovered models.

The console presents dashboard, source, plugin, and settings views. Host-owned
schema forms and explicit plugin UI slots keep presentation separate from
backend contracts. Source and preset manifests provide `configSchema`; `ui`
declares the four extension slots. Both are validated before rendering. The
authenticated `GET /admin/ui/catalog` rereads these JSON declarations and the
source-to-plugin mapping. Console refresh, successful source saves, and
supported plugin enable, disable, or uninstall operations update the slots,
forms, and plugin navigation. Authorized server-rendered pages also load the
current declarations. Contributions appear only for plugins enabled in the
runtime catalog.

Adding a channel stays inside one dialog: name and priority, then preset or
custom selection, then the preset's JSX or the host's schema form. Successful
creation closes the dialog and refreshes the channel list.
`POST /api/admin/sources` creates a UUID-identified source from
`{ id, name, priority, proxy?, sourcePluginId, presetId?, config }`, returning
`201` and an ETag; duplicate identity returns `409`. Name, priority, and plugin
ownership are persisted independently of provider configuration and survive
restarts and later edits. Lower priority values are selected first. Drafts and
provider credentials stay in dialog memory and are discarded when it closes;
they are never written to the URL or browser storage.

Channels can be renamed, reprioritized, enabled, disabled, or deleted through
ETag-protected operations. Instance enablement is independent of source plugin
enablement; restarting or toggling the plugin preserves the instance setting.
The ChatHub preset performs Microsoft authorization inside the setup dialog,
with an explicit external login link and a callback input. Its credentials are
held in memory until the channel is saved or the dialog is closed.

Editing an enabled plugin's `ui` or `configSchema` takes effect on refresh
without a console rebuild or server restart. Adding backend modules, changing
their runtime code, or changing host trust policy requires restarting the
executable. Plugin assets are served only at exact paths approved by host
policy; plugin actions also require a host-registered handler. See
[docs/operator-ui.md](docs/operator-ui.md) for a working registration example,
the UI port map, and source creation/setup contracts.

## UI previews

Open the self-contained operator [light](docs/previews/operator-light.html) and
[dark](docs/previews/operator-dark.html) previews, or the standalone Chat
[light](docs/previews/chat-light.html) and [dark](docs/previews/chat-dark.html)
previews, directly in a browser. Regenerate them from the server JSX components
and page styles with:

```text
deno task preview:ui
deno task preview:chat
```

These files use explicit sample data and disabled controls. They load no browser
application bundles and do not exercise live APIs, sessions, or interactive
plugin code. They are visual review artifacts, not evidence of real browser
interaction acceptance.

## Checks

```text
deno task check
deno task test
deno task verify
```

`check` covers server, browser, packages, plugins, scripts, and tests. Browser
checking uses DOM libraries without Deno globals. `test` runs `tests/`,
including architecture checks for dependency direction and the server/browser
boundary. `verify` covers formatting, linting, type checks, tests, and the
browser build in one gate.

## Plugin boundaries

Protocol plugins own wire routes and serialization. Source plugins own upstream
transport, credentials, provider error mapping, and conversion to HIP.
Middleware plugins transform requests or HIP streams in a validated, ordered
chain. API plugins own exact management routes. Presets validate user
configuration and produce source configuration; they do not execute upstream
requests.

Tool plugins declare model-visible tools and execute their calls through
bounded, cancelable host contracts. Chat consumes the host-provided tool
registry without depending on particular tool names or providers.

Third-party package bytes are verified and stored as immutable snapshots.
Verification is separate from execution: a stored package is never imported
implicitly. Only a host-registered trusted runtime or an isolated broker can
execute a package. UI extension registration does not grant backend plugin
execution permissions.

The default executable does not configure a PluginHost runtime factory or Worker
adapter and exposes no package upload/install API. Its live UI catalog refresh
does not install or reload backend plugin code. Built-in source plugins support
live enable/disable; built-in protocol and preset plugins remain immutable.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for dependency direction and build
boundaries, [docs/architecture.md](docs/architecture.md) for request and
rendering flows, [docs/internal-protocol.md](docs/internal-protocol.md) for HIP
invariants, and [docs/plugins.md](docs/plugins.md) for plugin contracts.

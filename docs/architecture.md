# Runtime Architecture

The runtime uses Deno, Hono, and Hono JSX. `./main.ts` starts one process that
serves gateway traffic, management APIs, and the operator console. Hono owns
HTTP routing. Server JSX produces complete read-only HTML; a browser JSX DOM
console island adds interaction through a separate module graph.

## Request flow

```text
client
  -> Hono route
  -> protocol plugin
  -> HIP OperationRequest
  -> kernel router and lifecycle
  -> source plugin
  -> HIP StreamFrame sequence
  -> protocol serializer
  -> JSON or SSE response
```

Protocol plugins own client wire formats. Source plugins own provider wire
formats and network calls. The kernel sees HIP values and capability ports. A
protocol plugin must never call an upstream directly.

Failover is allowed only before output reaches the caller. Once frames have been
released, a source exception ends that execution instead of replaying a model or
tool operation elsewhere. Request cancellation interrupts pending iterator reads
and cleanup, preserves the caller's reason, and does not cool down the channel.
The host requests source cleanup even when an implementation ignores
cancellation; stopping the host wait cannot forcibly terminate trusted
in-process plugin code.

## Console rendering and data flow

```text
GET /admin
  -> Hono HTTP route + redacted host snapshot
  -> web/pages + web/components (hono/jsx)
  -> complete initial HTML with one console mount point and local asset URLs

GET /admin/assets/console.js + console.css
  -> generated files in ./public/assets
  -> web/client/main.tsx (hono/jsx/dom)
  -> replace the console region with interactive components
  -> HTTP clients -> /admin/ui/request -> /api/admin/*
```

Server components own document and initial section composition. One browser
console island currently owns the interactive region; individual sections do not
mount independently. It loads and updates data through authenticated HTTP
requests. The server never imports `web/client`; the browser never imports
server modules. DTOs come from `packages/admin-contracts` through type-only
imports. Explicit shared form utilities operate on data only. Credentials and
storage handles are excluded from page props, extension contexts, and HTML.

Browser TSX files also imported by DOM tests use the single-line pragma
`/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */`. Both the
server-configured Deno test compiler and browser bundler recognize this form;
separate or multiline directives can select the wrong JSX runtime or produce
unsupported-directive warnings.

The console page is `/admin`. Management clients use `/api/admin/*`; existing
`/admin/*` management API aliases remain available. New page paths must not
overwrite those aliases. `/admin/assets/*` is reserved for static browser
output. Chat has its own SSR page at `/admin/chat` and browser island, backed by
the compatible `/api/chat/*` API and its cookie-authenticated
`/admin/chat/api/*` adapter. Its storage port owns conversation rename and
atomic deletion; the shared run registry rejects edits while a generation is
active.

The console authenticates through `POST /admin/session`, which sets an
eight-hour HttpOnly, SameSite=Strict cookie. The signed value contains an expiry
and nonce, not the admin token; the signing key is process-local.
`POST /admin/logout` clears the cookie. The server uses the configured bearer to
fetch authorized snapshots through the existing APIs. Browser islands forward
allowed operations through `POST /admin/ui/request`; its same-origin checks and
path/method allowlist prevent use as a general proxy. API clients calling
management routes directly still use bearer authentication. Sign-in and
read-only SSR pages work without JavaScript.

## Package ownership

| Location                         | Owns                                                     | Must not own                                |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| `packages/hip`                   | HIP types, frame rules, reducers, hashes                 | HTTP, persistence, provider DTOs            |
| `packages/contracts`             | Plugin manifests and capability contracts                | Hono, KV, SQLite, process startup           |
| `packages/source-sdk`            | Optional Deno transports for source plugins              | Host state, storage, forced routing         |
| `packages/kernel`                | Routing and lifecycle                                    | Wire parsing, provider names, Hono contexts |
| `packages/storage`               | Runtime-neutral storage ports                            | Concrete KV/SQLite adapters and HTTP routes |
| `packages/plugin-host`           | Verification, lifecycle, runtime ports                   | Implicit import/eval of packages            |
| `packages/admin-contracts`       | Serializable DTOs, UI descriptors, pure schema utilities | Secrets, runtime handles, Deno APIs         |
| `src/http`                       | Hono routes and transport behavior                       | Browser state and provider wire codecs      |
| `src/composition`                | Concrete host wiring                                     | UI state and Hono request handling          |
| `src/storage`                    | KV and SQLite adapters                                   | Protocol behavior and HTTP routes           |
| `src/web/components` and `pages` | Server JSX rendering                                     | Browser module imports and credentials      |
| `src/web/client`                 | Browser islands and HTTP clients                         | Server, Deno, Node, and storage imports     |

Packages cannot import applications, concrete plugins, or Hono. Plugins depend
on HIP/contracts and their own modules. Hono imports stay in the server's HTTP
and web layers. The composition root selects and assembles concrete
implementations. The optional source SDK supplies provider-side Deno transports;
the kernel and composition root never invoke it.

## Outbound proxy configuration

Composition owns a versioned proxy pool in `heimdall/proxy-pool`. Each channel
stores its selection alongside name and priority in host metadata, independently
of provider configuration. Pool and channel writes share the management write
queue; durable CAS writes precede updates to active selection bindings. Existing
source instances read those bindings through `getProxy()` at operation start.

`GET/PUT /admin/proxies` and `/api/admin/proxies` expose a credential-free pool
view and accept write-only Basic credentials. Omitting `basicAuth` retains an
entry's existing credentials by stable ID; `null` clears them. Updates use
`If-Match` and return the new ETag. URL userinfo, paths, queries and fragments
are rejected. The settings island and source dialogs consume only this view.
Pool changes do not replace source instances or alter in-flight transports.

The global default is either an enabled pool entry or direct. Channel overrides
can inherit, connect directly, or select an entry. A missing or disabled
explicit reference remains visible as unavailable. The host does not enforce
network routing; adoption belongs to each plugin. This outbound pool is
independent of `RuntimeSettings.proxyKey`, which is the gateway's inbound access
credential.

## UI contracts

Schema-to-form rendering belongs to the host. Composition loads source/preset
`configSchema` declarations, validates them, and sends them to authorized pages;
forms share labels, validation, secret handling, and submit states. UI
extensions declare a slot and trust mode. The four slots are `dashboard.widget`,
`source.status`, `settings.section`, and `nav.tab`. Schema rendering is the
executable's default. The extension library also implements trusted module
lifecycle and sandboxed iframe messaging; running these modes requires explicit
host integration. Browser action callbacks reach `/admin/ui/action`, where the
host reconstructs context and checks the enabled contribution, action allowlist,
and source ownership. Business handlers are explicitly registered through
`adminUiActions`.

[operator-ui.md](operator-ui.md) maps console interactions to existing backend
ports and records integration boundaries. Source creation uses
`POST /api/admin/sources`; metadata edits and deletion use `PATCH` and `DELETE`
with ETags. A channel's name, priority, and enabled state are stored separately
from its provider configuration and the source plugin's enabled state. The add
flow stays in one dialog, mounting either a reviewed preset JSX entry or a host
schema form.

## HTTP and storage rules

The Hono host performs request ID assignment, bounded body parsing, route
registration, cancellation wiring, and error mapping. Route conflicts are
rejected at composition time. Route parameters come from Hono's parameter API.
URL scanning with regular expressions is not application routing.

API errors use one stable envelope containing a code, message, and request ID.
SSE responses are produced by Hono streaming helpers so headers and cancellation
are handled at the transport boundary. Admin writes retain request IDs and ETags
across the HTTP boundary.

Configuration and plugin state use a single-tenant Deno KV namespace. Request,
frame, usage, and chat records use SQLite. The kernel depends on storage ports;
only `.` chooses concrete adapters. Credentials stay out of HIP frames, logs,
and response DTOs.

Background scheduling lives in `src/composition/background-tasks.ts`. It
subscribes to persisted runtime setting changes, owns its timers and probe
cancellation, and disposes before plugin and storage resources. Manual and
periodic checks share `probeSource`; the host bounds waits even if a plugin
ignores cancellation. Only the current channel instance and newest probe may
publish health or model discovery. Cancellation never marks a healthy source as
failed; timeout and provider failures still do.

## Build and development

`deno task dev` builds browser assets and watches web and server changes.
`deno task build:web` uses Deno's browser bundler to compile console and Chat
entries plus manifest-declared preset JSX modules into local `./public/assets`
files. The pinned Marked dependency tokenizes Markdown; host-owned JSX renders
allowed nodes without evaluating raw HTML. Reuse mature browser-safe libraries
for common concerns, while retaining the server/browser module boundary.
`deno task start` builds and serves; `deno task serve` runs with prebuilt
assets. Deploy the generated asset directory alongside the server.

`deno task verify` is the common gate for formatting, linting, type checking,
tests, and browser bundling. The browser has a separate type-check configuration
with DOM libraries and no Deno globals. Architecture tests enforce layer
imports, server/browser isolation, Hono JSX ownership, and the rule that all
test files, including `.tsx`, live under `tests/`.

See [../ARCHITECTURE.md](../ARCHITECTURE.md) for dependency and plugin
boundaries, and [../README.md](../README.md) for commands and runtime
configuration.

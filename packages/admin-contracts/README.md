# `@heimdall/admin-contracts`

Serializable DTOs and browser-safe UI contracts for the single-tenant operator
console live here. Hono server-rendered pages and browser JSX islands share this
package without importing each other's application code. The package has no
Deno, Node, Hono, storage adapter, or server implementation dependencies.

The DTOs are deliberately smaller than internal plugin and storage objects.
Credentials, raw package bytes, database handles, and HIP implementation state
must never cross this boundary.

- `mod.ts` contains administration API DTOs.
- `console.ts` describes the serializable console snapshot.
- `forms.ts` contains host-owned form descriptors, initial-value handling, and
  pure validation helpers. Secrets are omitted from rendered initial values.
- `form-schema.ts` validates untrusted form descriptions before host
  registration.
- `ui.ts` defines the four extension slots, JSON contexts/actions, manifest
  validation, and host policy selection for schema, trusted, or sandbox
  rendering.

Import DTOs with `import type`. Browser code may import constants and pure
runtime helpers from their contract modules explicitly. The architecture check
audits every module in this package for browser-safe dependencies and globals.
UI callbacks and DOM mount functions live in the web host, never in serialized
descriptors. Plugin metadata cannot grant itself trusted execution or permission
to call host actions.

Plugin browser entries may consume the public `ui.ts` slot/JSON contract and
`preset-ui.ts` form bridge. These contracts carry serializable values and pure
validators only; administrative catalogs and server implementation modules are
not plugin APIs. Architecture checks retain this explicit boundary.

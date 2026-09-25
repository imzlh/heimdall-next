# OpenAI protocol plugin

This plugin is the HTTP boundary for OpenAI Chat Completions and Responses. It
converts client JSON into HIP `GenerateRequest` values and converts HIP frames
back into JSON or SSE. It does not perform upstream I/O; source plugins own
provider calls.

## Module layout

- `manifest.json` declares routes, capabilities, and permissions.
- `contract.ts` owns route paths and the OpenAI dialect contract.
- `mod.ts` is the small plugin entry point and route matcher.
- `request.ts` is the stable request facade. Its implementation is split into
  `request/validation.ts`, `request/messages.ts`, `request/content.ts`, and
  `request/options.ts` so wire validation and vocabulary parsing stay local.
- `response.ts` materializes HIP events and builds non-streaming responses.
- `stream.ts` is the stable streaming facade. Chat and Responses event mapping
  live in `stream/chat.ts` and `stream/responses.ts`; tracker state and
  output-index helpers live in `stream/types.ts` and `stream/helpers.ts`.
- `serializer.ts` selects JSON or SSE output and owns stream lifecycle/error
  handling.
- `wire.ts` contains shared JSON, capability, and wire-format helpers.

The dependency direction is intentional:

```text
mod -> request/{messages,content,options,validation} -> wire
mod -> serializer -> response/stream/{chat,responses} -> wire
```

The adapter keeps private reasoning private, preserves unknown OpenAI fields in
HIP extensions, and treats an incomplete source stream as an error. Adding a new
OpenAI endpoint should extend `contract.ts`, `request.ts`, and the relevant
serializer without putting provider transport code in this plugin.

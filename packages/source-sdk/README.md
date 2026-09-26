# Optional source transport

This SDK is a plugin-owned adapter. The host only supplies a fresh, serializable
proxy selection through `SourceFactoryOptions.getProxy`; it never intercepts
`fetch`, changes process proxy settings, or forces a plugin to adopt the choice.

Create one transport per network operation so subsequent requests see updated
pool settings. Existing source sessions do not need to be rebuilt.

```ts
import { SourceTransport } from "@heimdall/source-sdk";

await using transport = new SourceTransport({
    getProxy: options.getProxy,
    signal,
    secrets: [config.apiKey],
});
const response = await transport.fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
});
```

`fetch()` and `webSocket()` support direct connections and explicit HTTP, HTTPS,
and SOCKS5 proxies. Direct and HTTP proxy connections use pinned
`undici@7.29.1`; SOCKS5 uses Deno's native client. The dependency is cached by
the normal prepare task and is never loaded from a browser CDN. TLS verification
stays enabled. Deployment certificates from `DENO_CERT` (or
`NODE_EXTRA_CA_CERTS`) are added to the direct/HTTP transport's trust bundle.

Use `await using` or await `close()` to release connection resources. Operation
and request abort signals both cancel active response bodies. Redirects require
explicit handling. Missing or disabled selected proxies fail without silently
switching routes.

Call `redact()` or `redactError()` on provider diagnostics before exposing them
or truncating them. Proxy credentials and supplied source secrets are filtered,
including encoded forms and nested error details.

`clientFor()` only exposes a native client for SOCKS or an existing plugin-owned
client. Use `fetch()`/`webSocket()` for the complete routing behavior. Explicit
`fetch` injection remains under the calling plugin's control. Without
`getProxy`, the existing fetch/client behavior is preserved; supplied clients
remain owned by the caller.

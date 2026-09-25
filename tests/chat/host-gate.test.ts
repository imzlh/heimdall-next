import { assert } from "@std/assert";
import { isPubliclyRoutableUrl } from "../../plugins/tool-web/host-gate.ts";

Deno.test("host-gate accepts a normal public https URL", () => {
    assert(isPubliclyRoutableUrl("https://example.com/path?q=1"));
    assert(isPubliclyRoutableUrl("https://sub.example.co.uk/"));
    assert(isPubliclyRoutableUrl("https://[2606:4700::1111]/"));
});

Deno.test("host-gate rejects non-https, credentials, and garbage", () => {
    assert(!isPubliclyRoutableUrl("http://example.com/"));
    assert(!isPubliclyRoutableUrl("ftp://example.com/"));
    assert(!isPubliclyRoutableUrl("https://user:pass@example.com/"));
    assert(!isPubliclyRoutableUrl("https://user@example.com/"));
    assert(!isPubliclyRoutableUrl("not a url"));
    assert(!isPubliclyRoutableUrl(""));
    assert(!isPubliclyRoutableUrl("example.com"));
});

Deno.test("host-gate rejects loopback, private, and link-local hosts", () => {
    assert(!isPubliclyRoutableUrl("https://localhost/"));
    assert(!isPubliclyRoutableUrl("https://app.localhost/"));
    assert(!isPubliclyRoutableUrl("https://127.0.0.1/"));
    assert(!isPubliclyRoutableUrl("https://127.9.9.9/"));
    assert(!isPubliclyRoutableUrl("https://10.0.0.1/"));
    assert(!isPubliclyRoutableUrl("https://192.168.1.1/"));
    assert(!isPubliclyRoutableUrl("https://172.16.0.1/"));
    assert(!isPubliclyRoutableUrl("https://169.254.169.254/"));
    assert(!isPubliclyRoutableUrl("https://0.0.0.0/"));
    assert(!isPubliclyRoutableUrl("https://[::1]/"));
    assert(!isPubliclyRoutableUrl("https://[::]/"));
    assert(!isPubliclyRoutableUrl("https://[fe80::1]/"));
    assert(!isPubliclyRoutableUrl("https://[fc00::1]/"));
});

Deno.test("host-gate blocks IPv4-mapped IPv6 of private and link-local ranges", () => {
    assert(!isPubliclyRoutableUrl("https://[::ffff:127.0.0.1]/"));
    assert(!isPubliclyRoutableUrl("https://[::ffff:10.0.0.1]/"));
    assert(!isPubliclyRoutableUrl("https://[::ffff:169.254.169.254]/"));
});

Deno.test("host-gate blocks obfuscated numeric spellings of loopback", () => {
    // The URL parser canonicalizes these to 127.0.0.1 before the gate sees them.
    assert(!isPubliclyRoutableUrl("https://0x7f000001/"));
    assert(!isPubliclyRoutableUrl("https://2130706433/"));
});

Deno.test("host-gate: allowLoopbackForTesting flips loopback only", () => {
    const allow = { allowLoopbackForTesting: true };
    assert(isPubliclyRoutableUrl("https://127.0.0.1/", allow));
    assert(isPubliclyRoutableUrl("https://localhost/", allow));
    assert(isPubliclyRoutableUrl("https://[::1]/", allow));
    // Private and link-local stay blocked even with the flag set.
    assert(!isPubliclyRoutableUrl("https://10.0.0.1/", allow));
    assert(!isPubliclyRoutableUrl("https://192.168.1.1/", allow));
    assert(!isPubliclyRoutableUrl("https://169.254.169.254/", allow));
    assert(!isPubliclyRoutableUrl("https://[fe80::1]/", allow));
    // The scheme and credential rules still apply.
    assert(!isPubliclyRoutableUrl("http://127.0.0.1/", allow));
    assert(!isPubliclyRoutableUrl("https://user:pass@127.0.0.1/", allow));
});

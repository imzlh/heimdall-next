/**
 * SSRF gate for URLs a model chose. Classifies the literal host of an `https:`
 * URL and admits only publicly routable destinations. No DNS is resolved: the
 * literal is judged, and TLS certificate verification (the caller's job) carries
 * what the literal cannot.
 */

export interface HostGateOptions {
    readonly allowLoopbackForTesting?: boolean;
}

/** Where a literal host points, reduced to the one distinction callers act on. */
type HostClass = "public" | "loopback" | "blocked";

/**
 * True only for an `https:` URL whose literal host is publicly routable. Rejects
 * non-https schemes, embedded credentials, loopback, private, link-local,
 * unique-local, unspecified addresses, and IPv4-mapped IPv6 of any of those. A
 * non-parseable URL is false. `allowLoopbackForTesting` admits loopback hosts for
 * offline tests while every other rule still applies.
 */
export function isPubliclyRoutableUrl(
    raw: string,
    options?: HostGateOptions,
): boolean {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    if (url.protocol !== "https:") return false;
    // Credentials in a URL are how a hostile link smuggles the part a reader skims.
    if (url.username || url.password) return false;
    const cls = classifyHost(url.hostname);
    if (cls === "public") return true;
    if (cls === "loopback") return options?.allowLoopbackForTesting === true;
    return false;
}

/** The URL parser hands us a normalized host; brackets mark an IPv6 literal. */
function classifyHost(rawHost: string): HostClass {
    let host = rawHost.toLowerCase();
    if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
    if (host.length === 0) return "blocked";
    if (host.includes(":")) {
        const groups = parseIpv6(host);
        return groups ? classifyIpv6(groups) : "blocked";
    }
    const octets = parseIpv4(host);
    if (octets) return classifyIpv4(octets);
    return classifyName(host);
}

/** A DNS name: only `localhost` is special here; anything else is treated as public. */
function classifyName(host: string): HostClass {
    if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
    return "public";
}

/** Strict dotted-quad. The URL parser has already canonicalized numeric spellings. */
function parseIpv4(host: string): number[] | null {
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of parts) {
        if (!/^[0-9]{1,3}$/.test(part)) return null;
        const value = Number(part);
        if (value > 255) return null;
        octets.push(value);
    }
    return octets;
}

function classifyIpv4(octets: number[]): HostClass {
    const a = octets[0] ?? 0;
    const b = octets[1] ?? 0;
    if (a === 127) return "loopback"; // 127.0.0.0/8
    if (a === 0) return "blocked"; // 0.0.0.0/8 unspecified
    if (a === 10) return "blocked"; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return "blocked"; // 172.16.0.0/12
    if (a === 192 && b === 168) return "blocked"; // 192.168.0.0/16
    if (a === 169 && b === 254) return "blocked"; // 169.254.0.0/16 link-local
    return "public";
}

/** Parse IPv6 into eight 16-bit groups, honouring `::` and an embedded IPv4 tail. */
function parseIpv6(text: string): number[] | null {
    const percent = text.indexOf("%");
    const address = percent >= 0 ? text.slice(0, percent) : text;
    const halves = address.split("::");
    if (halves.length > 2) return null;
    const head = parseGroups(halves[0] ?? "");
    const tail = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
    if (!head || !tail) return null;
    if (halves.length === 2) {
        const fill = 8 - head.length - tail.length;
        if (fill < 1) return null;
        return [...head, ...new Array<number>(fill).fill(0), ...tail];
    }
    return head.length === 8 ? head : null;
}

/** One colon-separated run of hex groups, with an optional trailing IPv4 literal. */
function parseGroups(segment: string): number[] | null {
    if (segment === "") return [];
    const tokens = segment.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i] ?? "";
        if (token.includes(".")) {
            if (i !== tokens.length - 1) return null;
            const v4 = parseIpv4(token);
            if (!v4) return null;
            groups.push(
                ((v4[0] ?? 0) << 8) | (v4[1] ?? 0),
                ((v4[2] ?? 0) << 8) | (v4[3] ?? 0),
            );
            continue;
        }
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        groups.push(Number.parseInt(token, 16));
    }
    return groups;
}

function classifyIpv6(g: number[]): HostClass {
    const at = (i: number): number => g[i] ?? 0;
    // IPv4-mapped ::ffff:0:0/96 denotes an IPv4 destination; judge the embedded one.
    if (
        at(0) === 0 && at(1) === 0 && at(2) === 0 && at(3) === 0 &&
        at(4) === 0 && at(5) === 0xffff
    ) {
        return classifyIpv4([
            at(6) >> 8,
            at(6) & 0xff,
            at(7) >> 8,
            at(7) & 0xff,
        ]);
    }
    if (g.slice(0, 7).every((x) => x === 0)) {
        if (at(7) === 1) return "loopback"; // ::1
        if (at(7) === 0) return "blocked"; // :: unspecified
    }
    if ((at(0) & 0xffc0) === 0xfe80) return "blocked"; // fe80::/10 link-local
    if ((at(0) & 0xfe00) === 0xfc00) return "blocked"; // fc00::/7 unique-local
    return "public";
}

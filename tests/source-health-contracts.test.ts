import { assertEquals, assertNotStrictEquals, assertThrows } from "@std/assert";
import {
    DEFAULT_SOURCE_HEALTH_POLICY,
    parseSourceHealthPolicy,
    readSourceCooldown,
} from "@heimdall/contracts/source-health.ts";

Deno.test("source health policy accepts bounded durations, inheritance and detached JSON only", () => {
    assertEquals(DEFAULT_SOURCE_HEALTH_POLICY, {
        cooldownMs: 30000,
        authCooldownMs: 300000,
    });
    assertEquals(parseSourceHealthPolicy(undefined), null);
    assertEquals(parseSourceHealthPolicy(null), null);
    const policy = { cooldownMs: 0, authCooldownMs: 86400000 };
    assertEquals(parseSourceHealthPolicy(policy), policy);
    assertNotStrictEquals(parseSourceHealthPolicy(policy), policy);
    let reads = 0;
    for (
        const value of [
            [],
            true,
            1,
            "policy",
            { unknown: 0 },
            { cooldownMs: -1 },
            { authCooldownMs: 86400001 },
            { cooldownMs: NaN },
            { cooldownMs: Infinity },
            { authCooldownMs: 0.5 },
            { cooldownMs: undefined },
            { [Symbol("policy")]: 0 },
            Object.create({ cooldownMs: 0 }),
            {
                get cooldownMs() {
                    reads++;
                    return 0;
                },
            },
        ]
    ) assertThrows(() => parseSourceHealthPolicy(value), TypeError);
    assertEquals(reads, 0);
});

Deno.test("durable cooldowns validate ISO dates, ordering, duration, reason and JSON fields", () => {
    const cooldown = {
        reason: "authentication",
        startedAt: "2026-10-01T08:00:00+08:00",
        until: "2026-10-01T00:05:00Z",
    };
    assertEquals(readSourceCooldown(cooldown), {
        reason: "authentication",
        startedAt: "2026-10-01T00:00:00.000Z",
        until: "2026-10-01T00:05:00.000Z",
    });
    for (
        const patch of [
            { reason: "credentials leaked" },
            { until: cooldown.startedAt },
            { until: "2026-09-30T00:00:00Z" },
            { until: "2026-10-02T00:00:00.001Z" },
            { startedAt: "2026-02-30T00:00:00Z" },
            { startedAt: "Oct 1, 2026" },
            { startedAt: "2026-10-01T00:00:00" },
            { diagnostic: "secret" },
        ]
    ) assertEquals(readSourceCooldown({ ...cooldown, ...patch }), undefined);
    let reads = 0;
    assertEquals(
        readSourceCooldown({
            ...cooldown,
            get until() {
                reads++;
                return cooldown.until;
            },
        }),
        undefined,
    );
    assertEquals(reads, 0);
    assertEquals(
        readSourceCooldown({ ...cooldown, until: "2026-10-02T00:00:00Z" })
            ?.until,
        "2026-10-02T00:00:00.000Z",
    );
});

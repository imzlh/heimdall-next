import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isUiJsonObject } from "@heimdall/admin-contracts/ui.ts";
import {
    buildChatHubQuota,
    chatHubAccountSnapshot,
} from "../../plugins/chathub-source/account.ts";
import { createChatHubSource } from "../../plugins/chathub-source/transport.ts";
import type { StreamEvent } from "@heimdall/contracts";
import { encodeRecord } from "../../plugins/chathub-source/protocol/codec.ts";
import type { WebSocketLike } from "../../plugins/chathub-source/protocol/types.ts";

Deno.test("ChatHub account projection bounds metering and rejects invalid allowances", () => {
    const quota = buildChatHubQuota(
        {
            metering: {
                LLMOnly: { remainingAllowance: Infinity },
                ImageGeneration: { remainingAllowance: -1 },
                Unrelated: { remainingAllowance: 100 },
            },
        },
        Array.from({ length: 50 }, () => ({
            hasAccess: false,
            meterError: `private-token${"x".repeat(200)}`,
        })),
        (text) => text.replaceAll("private-token", "[redacted]"),
    );
    assertEquals(quota?.meters.length, 8);
    assert(
        quota?.meters.every((meter) =>
            meter.remaining === undefined && meter.error!.length <= 160
        ),
    );
    const snapshot = chatHubAccountSnapshot(
        "operator@example.test",
        quota,
        undefined,
    );
    assert(isUiJsonObject(snapshot));
    assert(!JSON.stringify(snapshot).includes("private-token"));
    assertEquals(
        buildChatHubQuota({
            metering: { LLMOnly: { remainingAllowance: NaN } },
        }, []),
        undefined,
    );
    assertEquals(
        buildChatHubQuota(undefined, [
            ...Array.from(
                { length: 12 },
                () => ({ hasAccess: true, meterError: "" }),
            ),
            { hasAccess: false },
        ]),
        { meters: [{ name: "access", blocked: true }] },
    );
});

Deno.test("ChatHub updates only its account snapshot and redacts renewed credentials before truncation", async () => {
    const config = {
        id: "primary",
        oid: "private/object-id",
        tid: "private/tenant-id",
        accessToken: "previous/access-token",
        refreshToken: "previous/refresh-token",
        accountEmail: "operator@example.test",
        expiresAt: "2020-01-01T00:00:00Z",
        models: ["test-model"],
    };
    const nextAccessToken = "renewed/private-access-token";
    const nextRefreshToken = "renewed/private-refresh-token";
    const proxyPassword = "private/proxy-password";
    const secrets = [
        config.oid,
        config.tid,
        config.accessToken,
        config.refreshToken,
        nextAccessToken,
        nextRefreshToken,
        proxyPassword,
    ];
    let now = new Date("2026-09-29T08:00:00Z");
    let turn = 0;
    const source = createChatHubSource(config, {
        clock: () => now,
        getProxy: () => ({
            mode: "proxy",
            selectedBy: "source",
            proxy: {
                id: "a",
                name: "test proxy",
                url: "http://127.0.0.1:8081",
                basicAuth: { username: "test", password: proxyPassword },
            },
        }),
        refresh: () =>
            Promise.resolve({
                ok: true,
                oid: config.oid,
                tid: config.tid,
                accessToken: nextAccessToken,
                refreshToken: nextRefreshToken,
                email: `${encodeURIComponent(nextAccessToken)}@example.test`,
                expiresAt: "2099-01-01T00:00:00Z",
            }),
        webSocketFactory: () => {
            const denied = turn++ === 0;
            return new class extends EventTarget implements WebSocketLike {
                readyState = 0;
                #sends = 0;
                constructor() {
                    super();
                    queueMicrotask(() => {
                        this.readyState = 1;
                        this.dispatchEvent(new Event("open"));
                    });
                }
                send() {
                    const reply = ++this.#sends === 1
                        ? encodeRecord({})
                        : encodeRecord({
                            type: 2,
                            item: {
                                messages: denied
                                    ? []
                                    : [{ author: "bot", text: "回复" }],
                                throttling: {
                                    metering: {
                                        LLMOnly: {
                                            remainingAllowance: denied
                                                ? 41
                                                : 40,
                                        },
                                    },
                                },
                                result: {
                                    value: "Success",
                                    meteringInformation: denied
                                        ? secrets.map((secret) => ({
                                            hasAccess: false,
                                            meterError: `${secret} ${
                                                encodeURIComponent(secret)
                                            } ${"x".repeat(300)}`,
                                        }))
                                        : [],
                                },
                                turnState: "Completed",
                            },
                        }) + encodeRecord({ type: 3 });
                    queueMicrotask(() =>
                        this.dispatchEvent(
                            new MessageEvent("message", { data: reply }),
                        )
                    );
                }
                close() {
                    this.readyState = 3;
                }
            }();
        },
    });
    const execute = async () => {
        const events: StreamEvent[] = [];
        for await (
            const frame of source.execute({
                version: 1,
                requestId: "account-update",
                operation: "generation.create",
                traits: {},
                payload: {
                    model: "test-model",
                    messages: [{
                        id: "u",
                        role: "user",
                        parts: [{ id: "p", type: "text", text: "你好" }],
                    }],
                },
            }, {
                requestId: "account-update",
                signal: AbortSignal.timeout(2000),
                metadata: {},
            })
        ) {
            events.push(frame.event);
        }
        return events;
    };
    const deniedEvents = await execute();
    assertEquals(deniedEvents.at(-1)?.kind, "run.error");
    const first = source.uiSnapshot().account as Record<string, unknown>;
    assertEquals(first.updatedAt, now.toISOString());
    assertEquals(first.label, "[redacted]@example.test");
    const meters = first.meters as { error?: string }[];
    assertEquals(meters.length, 8);
    for (const meter of meters.slice(1)) {
        assertStringIncludes(meter.error!, "[redacted] [redacted]");
        assertEquals(meter.error!.length, 160);
    }
    for (const secret of secrets) {
        for (const representation of [secret, encodeURIComponent(secret)]) {
            assert(
                !JSON.stringify([first, deniedEvents]).includes(representation),
            );
        }
    }
    now = new Date("2026-09-29T08:01:00Z");
    const success = await execute();
    assertEquals(success.at(-1)?.kind, "run.completed");
    const second = source.uiSnapshot().account as Record<string, unknown>;
    assertEquals(second.updatedAt, now.toISOString());
    assertEquals(second.meters, [{ name: "LLMOnly", remaining: 40 }]);
    assertEquals(first.updatedAt, "2026-09-29T08:00:00.000Z");
    assert(
        success.every((event) =>
            event.kind !== "usage" ||
            !Object.hasOwn(event.usage.extensions ?? {}, "quota")
        ),
    );
});

Deno.test("ChatHub public account snapshot contains no credentials or private identifiers", () => {
    const source = createChatHubSource({
        id: "primary",
        oid: "private-object-id",
        tid: "private-tenant-id",
        accessToken: "private-access-token",
        refreshToken: "private-refresh-token",
        accountEmail: "private-access-token@example.test",
    });
    const snapshot = source.uiSnapshot();
    assert(isUiJsonObject(snapshot));
    const serialized = JSON.stringify(snapshot);
    for (
        const secret of [
            "private-object-id",
            "private-tenant-id",
            "private-access-token",
            "private-refresh-token",
        ]
    ) {
        assert(!serialized.includes(secret));
    }
    assertStringIncludes(serialized, "[redacted]@example.test");
    assertStringIncludes(serialized, "尚无额度快照");
});

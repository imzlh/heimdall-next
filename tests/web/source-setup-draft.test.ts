import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
    createSourceSetupDraft,
    type SourceSetupSelection,
} from "../../src/web/client/source-setup-draft.ts";

const PRESET: SourceSetupSelection = {
    name: "  主渠道  ",
    priority: -17,
    mode: "preset",
    presetId: "  heimdall.preset.newapi  ",
};

Deno.test("source creation keeps basic fields and a stable id when choosing again", () => {
    const draft = createSourceSetupDraft(PRESET);
    assertEquals(draft.name, "主渠道");
    assertEquals(draft.priority, -17);
    assertEquals(draft.mode, "preset");
    assertEquals(draft.presetId, "heimdall.preset.newapi");
    assertMatch(
        draft.id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const custom = createSourceSetupDraft(
        { ...draft, mode: "custom" },
        draft.id,
    );
    assertEquals(custom, {
        id: draft.id,
        name: "主渠道",
        priority: -17,
        mode: "custom",
    });
    const reselection = createSourceSetupDraft({
        ...PRESET,
        name: "改名渠道",
        priority: 3,
    }, custom.id);
    assertEquals(reselection.id, draft.id);
    assertEquals(reselection.name, "改名渠道");
    assertEquals(reselection.priority, 3);
    const independent = createSourceSetupDraft(PRESET);
    assertEquals(independent.id === draft.id, false);
});

Deno.test("source creation drafts copy only whitelisted fields and do not evaluate config or stale presets", () => {
    const input = {
        ...PRESET,
        mode: "custom" as const,
        config: { apiKey: "secret", payload: "x".repeat(50_000) },
        id: "injected-id",
        updatedAt: 0,
        toJSON() {
            throw new Error("The input must never be serialized.");
        },
    };
    for (const field of ["config", "presetId", "unrelated"]) {
        Object.defineProperty(input, field, {
            get() {
                throw new Error(
                    "Only the current selection fields may be read.",
                );
            },
        });
    }
    const draft = createSourceSetupDraft(input);
    assertEquals(draft.mode, "custom");
    assertEquals(Object.hasOwn(draft, "presetId"), false);
    assertEquals(Object.keys(draft).sort(), ["id", "mode", "name", "priority"]);
    assertEquals(JSON.stringify(draft).includes("secret"), false);
});

Deno.test("source creation works with blocked browser storage and never reads location", () => {
    const keys = ["localStorage", "sessionStorage", "location"] as const;
    const originals = keys.map((key) =>
        Object.getOwnPropertyDescriptor(globalThis, key)
    );
    try {
        for (const key of keys) {
            Object.defineProperty(globalThis, key, {
                configurable: true,
                get() {
                    throw new Error(
                        `${key} must not be used by the dialog draft`,
                    );
                },
            });
        }
        const draft = createSourceSetupDraft(PRESET);
        const custom = createSourceSetupDraft(
            { ...draft, mode: "custom" },
            draft.id,
        );
        assertEquals(custom.id, draft.id);
    } finally {
        keys.forEach((key, index) => {
            const original = originals[index];
            if (original) Object.defineProperty(globalThis, key, original);
            else Reflect.deleteProperty(globalThis, key);
        });
    }
});

Deno.test("source creation copies only a valid proxy identity and never coerces plugin values", () => {
    const input = {
        ...PRESET,
        proxy: {
            mode: "proxy" as const,
            proxyId: "office",
            url: "http://private.test",
            basicAuth: { username: "secret-user", password: "secret-password" },
        },
    };
    const draft = createSourceSetupDraft(input);
    assertEquals(draft.proxy, { mode: "proxy", proxyId: "office" });
    assertEquals(JSON.stringify(draft).includes("secret"), false);
    let calls = 0;
    const coercible = {
        toString: () => {
            calls++;
            return "office";
        },
    };
    for (
        const proxy of [
            { mode: "proxy" },
            { mode: "proxy", proxyId: 123 },
            { mode: "proxy", proxyId: coercible },
            { mode: "proxy:office" },
            { mode: coercible },
            {
                mode: "proxy",
                get proxyId() {
                    calls++;
                    return "office";
                },
            },
        ]
    ) {
        assertThrows(() =>
            createSourceSetupDraft({ ...PRESET, proxy } as SourceSetupSelection)
        );
    }
    assertEquals(calls, 0);
});

Deno.test("source creation uses UUID v4 on HTTP LAN origins without randomUUID", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    let randomReads = 0;
    try {
        Object.defineProperty(globalThis, "crypto", {
            configurable: true,
            value: {
                getRandomValues(bytes: Uint8Array): Uint8Array {
                    assertEquals(bytes.byteLength, 16);
                    bytes.fill(0xff);
                    bytes[15] = 0xff - randomReads++;
                    return bytes;
                },
            },
        });
        const first = createSourceSetupDraft(PRESET);
        const next = createSourceSetupDraft(PRESET);
        assertEquals(first.id, "ffffffff-ffff-4fff-bfff-ffffffffffff");
        assertEquals(next.id, "ffffffff-ffff-4fff-bfff-fffffffffffe");
        assertEquals(
            createSourceSetupDraft({ ...first, mode: "custom" }, first.id).id,
            first.id,
        );
        assertEquals(randomReads, 2);
    } finally {
        if (original) Object.defineProperty(globalThis, "crypto", original);
        else Reflect.deleteProperty(globalThis, "crypto");
    }
});

Deno.test("source creation rejects malformed basic fields and ignores inherited values or getters", () => {
    const invalid: unknown[] = [
        null,
        [],
        { ...PRESET, name: " \n\t " },
        { ...PRESET, name: "x".repeat(121) },
        { ...PRESET, name: 123 },
        { ...PRESET, priority: "1" },
        { ...PRESET, priority: 1.5 },
        { ...PRESET, priority: Number.MAX_SAFE_INTEGER + 1 },
        { ...PRESET, priority: NaN },
        { ...PRESET, priority: Infinity },
        { ...PRESET, mode: "other" },
        { ...PRESET, presetId: undefined },
        { ...PRESET, presetId: " \t " },
        { ...PRESET, presetId: "x".repeat(129) },
        { ...PRESET, presetId: {} },
        Object.create(PRESET),
    ];
    const accessor = { ...PRESET };
    let accessorCalled = false;
    Object.defineProperty(accessor, "name", {
        get() {
            accessorCalled = true;
            throw new Error("A field accessor must never be called.");
        },
    });
    invalid.push(accessor);
    for (const selection of invalid) {
        assertThrows(
            () => createSourceSetupDraft(selection as SourceSetupSelection),
            Error,
        );
    }
    assertEquals(accessorCalled, false);
    const boundary = createSourceSetupDraft({
        name: "x".repeat(120),
        priority: Number.MAX_SAFE_INTEGER,
        mode: "preset",
        presetId: "y".repeat(128),
    });
    assertEquals(boundary.name.length, 120);
    assertEquals(boundary.priority, Number.MAX_SAFE_INTEGER);
    assertEquals(boundary.presetId?.length, 128);
    for (
        const id of [
            "",
            "__proto__",
            "../token",
            "x".repeat(1000),
            "11111111-1111-1111-1111-111111111111",
        ]
    ) {
        assertThrows(
            () => createSourceSetupDraft(PRESET, id),
            Error,
            "渠道创建标识无效",
        );
    }
});

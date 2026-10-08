import { assertEquals, assertThrows } from "@std/assert";
import {
    readSourceHealthPolicyDraft,
    sameSourceHealthPolicy,
    sourceHealthPolicyDraft,
} from "../../src/web/client/source-health-policy.tsx";
import {
    createSourceSetupDraft,
    type SourceSetupSelection,
} from "../../src/web/client/source-setup-draft.ts";

Deno.test("health policy seconds preserve exact milliseconds, zero and inherited fields", () => {
    assertEquals(
        readSourceHealthPolicyDraft({
            mode: "custom",
            cooldownSeconds: "1.001",
            authCooldownSeconds: "0",
        }),
        { cooldownMs: 1001, authCooldownMs: 0 },
    );
    assertEquals(
        readSourceHealthPolicyDraft({
            mode: "custom",
            cooldownSeconds: "",
            authCooldownSeconds: "86400",
        }),
        { authCooldownMs: 86_400_000 },
    );
    assertEquals(
        readSourceHealthPolicyDraft(
            sourceHealthPolicyDraft({ cooldownMs: 1, authCooldownMs: 29 }),
        ),
        { cooldownMs: 1, authCooldownMs: 29 },
    );
    assertEquals(
        readSourceHealthPolicyDraft({
            mode: "inherit",
            cooldownSeconds: "invalid",
            authCooldownSeconds: "-1",
        }),
        null,
    );
    assertEquals(sameSourceHealthPolicy(undefined, null), true);
    assertEquals(
        sameSourceHealthPolicy({ cooldownMs: 0 }, { cooldownMs: 0 }),
        true,
    );
    assertEquals(sameSourceHealthPolicy({ cooldownMs: 0 }, null), false);
    for (
        const value of [
            "-1",
            "86400.001",
            "0.0001",
            "Infinity",
            "1e3",
            "invalid",
        ]
    ) {
        assertThrows(
            () =>
                readSourceHealthPolicyDraft({
                    mode: "custom",
                    cooldownSeconds: value,
                    authCooldownSeconds: "",
                }),
            TypeError,
        );
    }
});

Deno.test("source setup keeps detached health metadata through preset choices and rejects invalid policies", () => {
    const policy = { cooldownMs: 1250, authCooldownMs: 0 };
    const selection: SourceSetupSelection = {
        name: "健康渠道",
        priority: 0,
        mode: "preset",
        presetId: "example.preset",
        healthPolicy: policy,
    };
    const draft = createSourceSetupDraft(selection);
    policy.cooldownMs = 9999;
    assertEquals(draft.healthPolicy, { cooldownMs: 1250, authCooldownMs: 0 });
    assertEquals(
        createSourceSetupDraft({ ...draft, mode: "custom" }, draft.id)
            .healthPolicy,
        draft.healthPolicy,
    );
    assertEquals(
        createSourceSetupDraft({ ...draft, healthPolicy: null }, draft.id)
            .healthPolicy,
        null,
    );
    for (
        const healthPolicy of [{ cooldownMs: -1 }, { authCooldownMs: 0.5 }, {
            token: "secret",
        }, []]
    ) {
        assertThrows(() =>
            createSourceSetupDraft(
                { ...selection, healthPolicy } as SourceSetupSelection,
            )
        );
    }
});

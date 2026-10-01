import { assertEquals, assertExists, assertStrictEquals } from "@std/assert";
import type { InferenceSource, StreamFrame } from "@heimdall/contracts";
import { applySourcePriority } from "@heimdall/core/composition/source-records.ts";

class AccountSource implements InferenceSource {
    readonly id = "account-source";
    readonly capabilities = [{
        operation: "generation.create",
        streaming: true,
        priority: 1,
    }];
    #remaining = 10;

    consume(count: number) {
        this.#remaining -= count;
    }

    uiSnapshot() {
        // A real plugin can read private state: calling an unbound method fails.
        return { account: { remaining: this.#remaining } };
    }

    probe() {
        return Promise.resolve({
            ok: true,
            message: `remaining ${this.#remaining}`,
        });
    }

    execute(): AsyncIterable<StreamFrame> {
        throw new Error("Reading cached UI state must not execute inference");
    }
}

Deno.test("source priority updates preserve live plugin UI state and its original method receiver", async () => {
    const source = new AccountSource();
    const first = applySourcePriority(source, 7);
    const second = applySourcePriority(first, -2);
    assertExists(first.uiSnapshot);
    assertExists(second.uiSnapshot);
    assertEquals(first.uiSnapshot(), { account: { remaining: 10 } });
    source.consume(3);
    assertEquals(second.uiSnapshot(), { account: { remaining: 7 } });
    source.consume(1);
    assertEquals(first.uiSnapshot(), { account: { remaining: 6 } });
    assertEquals(second.uiSnapshot(), { account: { remaining: 6 } });
    assertEquals(await second.probe!(new AbortController().signal), {
        ok: true,
        message: "remaining 6",
    });
    assertEquals(first.capabilities[0]?.priority, 7);
    assertEquals(second.capabilities[0]?.priority, -2);
    assertEquals(source.capabilities[0]?.priority, 1);
    assertStrictEquals(applySourcePriority(second, undefined), second);
});

Deno.test("source priority wrapping does not invent unsupported UI snapshot methods", () => {
    const source: InferenceSource = {
        id: "plain-source",
        capabilities: [{ operation: "generation.create", streaming: false }],
        execute(): AsyncIterable<StreamFrame> {
            throw new Error("not executed");
        },
    };
    const wrapped = applySourcePriority(applySourcePriority(source, 2), 3);
    assertEquals(wrapped.uiSnapshot, undefined);
    assertEquals(Object.hasOwn(wrapped, "uiSnapshot"), false);
    assertEquals(wrapped.probe, undefined);
    assertEquals(wrapped.capabilities[0]?.priority, 3);
});

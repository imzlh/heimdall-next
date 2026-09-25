import { assertEquals, assertThrows } from "@std/assert";
import { randomUuid } from "../../src/web/client/random-id.ts";

function withCrypto(value: object, check: () => void) {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    try {
        Object.defineProperty(globalThis, "crypto", {
            configurable: true,
            value,
        });
        check();
    } finally {
        if (original) Object.defineProperty(globalThis, "crypto", original);
        else Reflect.deleteProperty(globalThis, "crypto");
    }
}

Deno.test("browser UUIDs prefer the native cryptographic generator and preserve its receiver", () => {
    const expected = "02468ace-1357-49bd-8ace-02468ace1357";
    const cryptography = {
        randomUUID() {
            assertEquals(this, cryptography);
            return expected;
        },
        getRandomValues() {
            throw new Error("native randomUUID is available");
        },
    };
    withCrypto(cryptography, () => assertEquals(randomUuid(), expected));
});

Deno.test("browser UUID fallback preserves secure bytes and RFC version/variant on HTTP origins", () => {
    let draws = 0;
    const cryptography = {
        getRandomValues(bytes: Uint8Array) {
            assertEquals(this, cryptography);
            assertEquals(bytes.length, 16);
            for (let index = 0; index < bytes.length; index++) {
                bytes[index] = index;
            }
            draws++;
            return bytes;
        },
    };
    withCrypto(cryptography, () => {
        assertEquals(randomUuid(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
        assertEquals(draws, 1);
    });
    // Missing browser cryptography must fail rather than produce guessable nonces.
    withCrypto({}, () => assertThrows(randomUuid, TypeError));
});

import { assertEquals, assertThrows } from "@std/assert";
import {
    type PrunableJournal,
    readRetentionDays,
    runMaintenance,
} from "@heimdall/core/composition/maintenance.ts";

function fakeJournal(agedCount: number): {
    journal: PrunableJournal;
    calls: { before: string; maxDeletes: number }[];
} {
    let remaining = agedCount;
    const calls: { before: string; maxDeletes: number }[] = [];
    const journal: PrunableJournal = {
        pruneOlderThan(before: string, maxDeletes: number) {
            calls.push({ before, maxDeletes });
            const deleted = Math.min(remaining, maxDeletes);
            remaining -= deleted;
            return { deleted, done: deleted < maxDeletes };
        },
    };
    return { journal, calls };
}

Deno.test("runMaintenance is disabled when retention is zero", () => {
    const { journal, calls } = fakeJournal(100);
    assertEquals(
        runMaintenance(journal, { retentionDays: 0 }).prunedRequests,
        0,
    );
    assertEquals(calls.length, 0);
});

Deno.test("runMaintenance drains aged records in bounded batches", () => {
    const { journal, calls } = fakeJournal(1200);
    const result = runMaintenance(journal, {
        retentionDays: 30,
        batchSize: 500,
        now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    assertEquals(result.prunedRequests, 1200);
    assertEquals(calls.length, 3);
    assertEquals(calls[0]?.before, "2029-12-02T00:00:00.000Z");
});
Deno.test("runMaintenance respects the per-sweep budget", () => {
    const { journal } = fakeJournal(100_000);
    const result = runMaintenance(journal, {
        retentionDays: 7,
        maxDeletesPerSweep: 1_000,
        batchSize: 400,
    });
    assertEquals(result.prunedRequests, 1_000);
});

Deno.test("readRetentionDays parses and validates the env value", () => {
    assertEquals(readRetentionDays(undefined), 0);
    assertEquals(readRetentionDays("   "), 0);
    assertEquals(readRetentionDays("30"), 30);
    assertThrows(() => readRetentionDays("-1"), RangeError);
    assertThrows(() => readRetentionDays("abc"), RangeError);
    assertThrows(() => readRetentionDays("9999"), RangeError);
});

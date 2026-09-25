import { assertEquals, assertThrows } from "@std/assert";
import {
    addDays,
    civilDate,
    dayStart,
    isCivilDate,
    naturalDay,
    recentNaturalDays,
    resolveTimeZone,
} from "@heimdall/core/stats/calendar.ts";

Deno.test("natural days start at local midnight, not UTC midnight", () => {
    assertEquals(
        new Date(dayStart("2026-09-24", "Asia/Shanghai")).toISOString(),
        "2026-09-23T16:00:00.000Z",
    );
    assertEquals(
        new Date(dayStart("2026-09-24", "UTC")).toISOString(),
        "2026-09-24T00:00:00.000Z",
    );
    // 00:30 in Shanghai is still the previous date in UTC.
    assertEquals(
        civilDate(Date.parse("2026-09-23T16:30:00.000Z"), "Asia/Shanghai"),
        "2026-09-24",
    );
});

Deno.test("DST days are 23 or 25 hours long", () => {
    assertEquals(naturalDay("2026-03-08", "America/New_York"), {
        date: "2026-03-08",
        from: "2026-03-08T05:00:00.000Z",
        until: "2026-03-09T04:00:00.000Z",
    });
    assertEquals(naturalDay("2026-11-01", "America/New_York"), {
        date: "2026-11-01",
        from: "2026-11-01T04:00:00.000Z",
        until: "2026-11-02T05:00:00.000Z",
    });
});

Deno.test("a day without a midnight starts at the DST transition", () => {
    // Brazil jumped from 00:00 straight to 01:00 on 2018-11-04.
    const day = naturalDay("2018-11-04", "America/Sao_Paulo");
    assertEquals(day.from, "2018-11-04T03:00:00.000Z");
    assertEquals(
        civilDate(Date.parse(day.from) - 1, "America/Sao_Paulo"),
        "2018-11-03",
    );
});

Deno.test("recent natural days are contiguous, oldest first, and end today", () => {
    // 09:00 in Shanghai, but still the previous evening in New York.
    const now = new Date("2026-09-24T01:00:00.000Z");
    const days = recentNaturalDays(7, "Asia/Shanghai", now);
    assertEquals(days.map((day) => day.date), [
        "2026-09-18",
        "2026-09-19",
        "2026-09-20",
        "2026-09-21",
        "2026-09-22",
        "2026-09-23",
        "2026-09-24",
    ]);
    for (let index = 1; index < days.length; index++) {
        assertEquals(days[index]!.from, days[index - 1]!.until);
    }
    assertEquals(days[6]!.from, "2026-09-23T16:00:00.000Z");
    assertEquals(
        recentNaturalDays(1, "America/New_York", now)[0]!.date,
        "2026-09-23",
    );
    assertThrows(() => recentNaturalDays(0, "UTC", now), RangeError);
});

Deno.test("calendar dates and zone names are validated", () => {
    assertEquals(isCivilDate("2024-02-29"), true);
    assertEquals(isCivilDate("2026-02-29"), false);
    assertEquals(isCivilDate("2026-9-1"), false);
    assertEquals(isCivilDate("2026-09-01T00:00:00Z"), false);
    assertEquals(addDays("2026-03-01", -1), "2026-02-28");
    assertEquals(addDays("2026-12-31", 1), "2027-01-01");
    assertThrows(() => addDays("2026-02-30", 1), RangeError);
    assertEquals(resolveTimeZone(" asia/shanghai "), "Asia/Shanghai");
    assertEquals(
        resolveTimeZone(undefined),
        Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    assertThrows(() => resolveTimeZone("Mars/Olympus"), RangeError);
});

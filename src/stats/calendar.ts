/**
 * Natural-day arithmetic for usage statistics.
 *
 * A natural day is a civil date in one IANA time zone, not a UTC slice, so
 * "today" follows the operator's wall clock. Boundaries come from Intl alone:
 * no bundled zone database, and DST days are 23 or 25 hours long instead of a
 * fixed 24.
 */

const DAY_MS = 86_400_000;
/**
 * Offsets span UTC-12..UTC+14, and a DST gap delays a day's start by at most
 * another hour, so every day starts within this distance of its UTC midnight.
 */
const SEARCH_WINDOW_MS = 16 * 3_600_000;
const CIVIL_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();
const clockFormatters = new Map<string, Intl.DateTimeFormat>();

export interface NaturalDay {
    /** Civil date, YYYY-MM-DD. */
    readonly date: string;
    /** Inclusive start as an ISO-8601 UTC timestamp. */
    readonly from: string;
    /** Exclusive end: the next day's start. */
    readonly until: string;
}

/**
 * Canonical IANA name for `value`, or the process zone when it is unset.
 * Throws RangeError for a zone Intl does not know.
 */
export function resolveTimeZone(value?: string): string {
    const requested = value?.trim();
    try {
        return new Intl.DateTimeFormat(
            "en-US",
            requested ? { timeZone: requested } : {},
        ).resolvedOptions().timeZone;
    } catch {
        throw new RangeError(`unknown time zone: ${requested}`);
    }
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isCivilDate(value: string): boolean {
    return civilMidnightUtc(value) !== undefined;
}

/** Calendar arithmetic that ignores zones: `addDays("2026-03-01", -1)`. */
export function addDays(date: string, days: number): string {
    return new Date(requireCivilMidnight(date) + days * DAY_MS).toISOString()
        .slice(0, 10);
}

/** The civil date `instant` (epoch ms) falls on in `timeZone`. */
export function civilDate(instant: number, timeZone: string): string {
    let year = "";
    let month = "";
    let day = "";
    for (const part of formatter(timeZone).formatToParts(instant)) {
        if (part.type === "year") year = part.value;
        else if (part.type === "month") month = part.value;
        else if (part.type === "day") day = part.value;
    }
    return `${year.padStart(4, "0")}-${month}-${day}`;
}

/** Wall clock "HH:mm" of `instant` (epoch ms) in `timeZone`, midnight as 00:00. */
export function civilClock(instant: number, timeZone: string): string {
    let cached = clockFormatters.get(timeZone);
    if (cached === undefined) {
        cached = new Intl.DateTimeFormat("en-GB", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        });
        clockFormatters.set(timeZone, cached);
    }
    return cached.format(instant);
}

/** First instant (epoch ms) whose civil date in `timeZone` is `date`. */
export function dayStart(date: string, timeZone: string): number {
    const midnight = requireCivilMidnight(date);
    // Binary search at one-second resolution; zone transitions fall on whole
    // seconds, so the boundary found is exact. `low` reads an earlier date and
    // `high` reads `date` or later throughout.
    let low = Math.floor((midnight - SEARCH_WINDOW_MS) / 1000);
    let high = Math.ceil((midnight + SEARCH_WINDOW_MS) / 1000);
    while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (civilDate(middle * 1000, timeZone) >= date) high = middle;
        else low = middle;
    }
    return high * 1000;
}

/** Boundaries of one natural day. */
export function naturalDay(date: string, timeZone: string): NaturalDay {
    return {
        date,
        from: new Date(dayStart(date, timeZone)).toISOString(),
        until: new Date(dayStart(addDays(date, 1), timeZone)).toISOString(),
    };
}

/** The `count` natural days ending with the one containing `now`, oldest first. */
export function recentNaturalDays(
    count: number,
    timeZone: string,
    now: Date,
): NaturalDay[] {
    if (!Number.isInteger(count) || count < 1) {
        throw new RangeError("count must be a positive integer");
    }
    const today = civilDate(now.getTime(), timeZone);
    const days: NaturalDay[] = [];
    let start = dayStart(addDays(today, 1 - count), timeZone);
    for (let offset = count - 1; offset >= 0; offset--) {
        const date = addDays(today, -offset);
        const next = dayStart(addDays(date, 1), timeZone);
        days.push({
            date,
            from: new Date(start).toISOString(),
            until: new Date(next).toISOString(),
        });
        start = next;
    }
    return days;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
    let cached = formatters.get(timeZone);
    if (cached === undefined) {
        cached = new Intl.DateTimeFormat("en-US", {
            timeZone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        });
        formatters.set(timeZone, cached);
    }
    return cached;
}

function civilMidnightUtc(value: string): number | undefined {
    const match = CIVIL_DATE.exec(value);
    if (match === null) return undefined;
    const [, year, month, day] = match.map(Number) as [
        number,
        number,
        number,
        number,
    ];
    const midnight = Date.UTC(year, month - 1, day);
    // Date.UTC rolls 2026-02-30 over to March; a real date round-trips.
    return new Date(midnight).toISOString().slice(0, 10) === value
        ? midnight
        : undefined;
}

function requireCivilMidnight(date: string): number {
    const midnight = civilMidnightUtc(date);
    if (midnight === undefined) {
        throw new RangeError(`not a calendar date: ${date}`);
    }
    return midnight;
}

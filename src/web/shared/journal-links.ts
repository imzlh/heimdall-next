export interface JournalLocation {
    readonly q?: string;
    readonly status?: string;
    readonly cursor?: string | null;
    readonly selectedId?: string;
}

/** Keep native navigation on request logs, including before JS is available. */
export function journalHref(
    location: JournalLocation,
    update: Record<string, string | null> = {},
): string {
    const query = new URLSearchParams({ view: "requests" });
    if (location.q) query.set("q", location.q);
    if (location.status) query.set("status", location.status);
    if (location.cursor) query.set("cursor", location.cursor);
    if (location.selectedId) query.set("id", location.selectedId);
    for (const [key, value] of Object.entries(update)) {
        if (value === null) query.delete(key);
        else query.set(key, value);
    }
    return `/admin?${query}`;
}

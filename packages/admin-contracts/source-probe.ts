/** A draft probe never creates, updates or changes the health of a saved channel. */
export interface SourceDraftProbeResult {
    readonly ok: boolean;
    readonly message: string;
    readonly checkedAt: string;
    /** Optional discovery data, not a requirement for successful connectivity. */
    readonly models?: readonly string[];
}

/** Host-owned categories only: never expose upstream error text or credentials. */
export type SourceCooldownReason =
    | "authentication"
    | "rate_limit"
    | "upstream"
    | "transport"
    | "probe";

export interface SourceCooldown {
    readonly reason: SourceCooldownReason;
    readonly startedAt: string;
    readonly until: string;
}

/** Ready means eligible for routing, not proof that the upstream is healthy. */
export interface SourceHealthSnapshot {
    readonly health: "ready" | "cooldown";
    readonly cooldown?: SourceCooldown;
}

/** A source configuration/override owns a generation; checks within it are ordered. */
export interface SourceHealthCheck {
    readonly generation: symbol;
    readonly sequence: number;
}

/** New pending traffic cannot suppress evidence from an earlier completed check. */
export class SourceHealthOrder {
    readonly #generation = Symbol();
    #issued = 0;
    #applied = 0;

    begin(): SourceHealthCheck {
        return { generation: this.#generation, sequence: ++this.#issued };
    }

    accept(check: SourceHealthCheck): boolean {
        if (
            check.generation !== this.#generation ||
            check.sequence <= this.#applied
        ) return false;
        this.#applied = check.sequence;
        return true;
    }
}

export function upstreamCooldownReason(status?: number): SourceCooldownReason {
    if (status === 401 || status === 403) return "authentication";
    if (status === 429) return "rate_limit";
    return "upstream";
}

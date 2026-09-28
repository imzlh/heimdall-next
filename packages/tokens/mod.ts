/**
 * Rule-based token estimation, shared by the kernel's usage fallback and by
 * sources that report no upstream token counts of their own (e.g. ChatHub).
 *
 * The heuristic is deliberately coarse: it exists so every request carries a
 * token figure even when the provider gives none, not to match a real
 * tokenizer. The non-CJK ratio leans slightly high on purpose — these counts
 * feed sources that aren't token-billed, and the tally omits per-message
 * structural overhead, so rounding up beats undercounting.
 */

/** Character counts split by script, since the two estimate very differently. */
export interface TokenTally {
    /** CJK/kana/hangul/fullwidth code points: roughly one token each. */
    cjk: number;
    /** Everything else: roughly 3.5 characters per token. */
    other: number;
}

export function newTally(): TokenTally {
    return { cjk: 0, other: 0 };
}

/** CJK/kana/hangul/fullwidth code points count as roughly one token each. */
export function isCjk(code: number): boolean {
    return (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef);
}

/** Fold `text` into an existing tally, classifying each code point. */
export function addText(tally: TokenTally, text: string): void {
    for (const char of text) {
        if (isCjk(char.codePointAt(0)!)) tally.cjk += 1;
        else tally.other += 1;
    }
}

/** Convert a tally to an estimated token count. */
export function tokensOf(tally: TokenTally): number {
    return tally.cjk + Math.ceil(tally.other / 3.5);
}

/** Estimate the token count of a single string. */
export function estimateTokens(text: string): number {
    const tally = newTally();
    addText(tally, text);
    return tokensOf(tally);
}

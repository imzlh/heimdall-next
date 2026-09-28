import type {
    FrameDto,
    RequestDetailDto,
    RequestStatusDto,
    RequestSummaryDto,
} from "./mod.ts";

export interface RequestJournalQuery {
    readonly q?: string;
    readonly status?: RequestStatusDto;
    /** Opaque position returned by the previous list response. */
    readonly cursor?: string;
    /** Legacy exclusive timestamp bound. */
    readonly before?: string;
    /** Positive integer capped at 100; defaults to 50. */
    readonly limit?: number;
}

export interface RequestJournalListResponse {
    readonly requests: readonly RequestSummaryDto[];
    readonly nextCursor: string | null;
}

export interface RequestJournalDetailQuery {
    /** Exclusive sequence position; defaults to -1. */
    readonly afterSeq?: number;
    /** Positive integer capped at 200; defaults to 100. */
    readonly frameLimit?: number;
}

export interface RequestJournalDetailResponse {
    readonly request: RequestDetailDto;
    readonly frames: readonly FrameDto[];
    readonly nextAfterSeq: number | null;
}

/** Download contains all frames captured when the export began. */
export interface RequestJournalExportResponse {
    readonly request: RequestDetailDto;
    readonly frames: readonly FrameDto[];
}

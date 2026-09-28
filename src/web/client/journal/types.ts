import type {
    FrameDto,
    RequestDetailDto,
    RequestStatusDto,
    RequestSummaryDto,
} from "@heimdall/admin-contracts";

export interface JournalInitial {
    readonly requests: readonly RequestSummaryDto[];
    readonly nextCursor: string | null;
    readonly error: string;
    readonly q?: string;
    readonly status?: RequestStatusDto;
    readonly cursor?: string | null;
    readonly selectedId?: string;
    readonly detail?: JournalDetail;
    readonly detailError?: string;
}

export interface JournalList {
    readonly requests: readonly RequestSummaryDto[];
    readonly nextCursor: string | null;
}

export interface JournalDetail {
    readonly request: RequestDetailDto;
    readonly frames: readonly FrameDto[];
    readonly nextAfterSeq: number | null;
}

export interface JournalExport {
    readonly request: RequestDetailDto;
    readonly frames: readonly FrameDto[];
}

export interface JournalQuery {
    readonly q?: string;
    readonly status?: RequestStatusDto;
    readonly cursor?: string | null;
    readonly limit?: number;
    readonly signal?: AbortSignal;
}

export interface JournalApi {
    list(query: JournalQuery): Promise<JournalList>;
    detail(id: string, options: {
        afterSeq?: number;
        frameLimit?: number;
        signal?: AbortSignal;
    }): Promise<JournalDetail>;
    export(
        id: string,
        options: { signal?: AbortSignal },
    ): Promise<JournalExport>;
}

export interface JournalState extends JournalList {
    readonly q: string;
    readonly status: RequestStatusDto | "";
    readonly cursor: string | null;
    readonly page: number;
    readonly canPrevious: boolean;
    readonly loading: boolean;
    readonly error: string;
    readonly autoRefresh: boolean;
    readonly visible: boolean;
    readonly selectedId: string;
    readonly detail: RequestDetailDto | null;
    readonly frames: readonly FrameDto[];
    readonly nextAfterSeq: number | null;
    readonly detailLoading: boolean;
    readonly detailError: string;
    readonly framesLoading: boolean;
    readonly framesError: string;
    readonly action: "copy" | "download" | "";
    readonly actionError: string;
    readonly notice: string;
}

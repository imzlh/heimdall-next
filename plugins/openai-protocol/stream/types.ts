export interface ResponsesTracker {
    nextSequenceNumber: number;
    nextOutputIndex: number;
    readonly outputIndexes: Map<string, number>;
    readonly contentIndexes: Map<string, number>;
    readonly nextContentIndexes: Map<string, number>;
}

export function createResponsesTracker(): ResponsesTracker {
    return {
        nextSequenceNumber: 0,
        nextOutputIndex: 0,
        outputIndexes: new Map(),
        contentIndexes: new Map(),
        nextContentIndexes: new Map(),
    };
}

import { RECORD_SEPARATOR } from "./constants.ts";

export class SignalRCodecError extends Error {
    constructor(
        message: string,
        public readonly record?: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "SignalRCodecError";
    }
}

/** Encodes one JSON value as a SignalR JSON record. */
export function encodeRecord(value: unknown): string {
    try {
        return JSON.stringify(value) + RECORD_SEPARATOR;
    } catch (cause) {
        throw new SignalRCodecError(
            "Failed to encode SignalR JSON record",
            undefined,
            {
                cause,
            },
        );
    }
}

/** Encodes multiple values into one WebSocket text payload. */
export function encodeRecords(values: Iterable<unknown>): string {
    let payload = "";
    for (const value of values) payload += encodeRecord(value);
    return payload;
}

/**
 * Incrementally decodes Record Separator-delimited SignalR JSON records.
 * Incomplete trailing data is retained until a later push.
 */
export class SignalRRecordDecoder {
    #buffer = "";

    get pending(): string {
        return this.#buffer;
    }

    push(chunk: string): unknown[] {
        this.#buffer += chunk;
        const records = this.#buffer.split(RECORD_SEPARATOR);
        this.#buffer = records.pop() ?? "";

        const values: unknown[] = [];
        for (const record of records) {
            if (record.length === 0) continue;
            try {
                values.push(JSON.parse(record));
            } catch (cause) {
                throw new SignalRCodecError(
                    "Invalid SignalR JSON record",
                    record,
                    {
                        cause,
                    },
                );
            }
        }
        return values;
    }

    finish(): void {
        if (this.#buffer.length > 0) {
            const record = this.#buffer;
            this.#buffer = "";
            throw new SignalRCodecError(
                "SignalR stream ended with an incomplete record",
                record,
            );
        }
    }

    reset(): void {
        this.#buffer = "";
    }
}

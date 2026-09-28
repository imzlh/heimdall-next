import type { RequestDetailDto } from "@heimdall/admin-contracts";
import type { RequestStore } from "@heimdall/storage";

/**
 * Export the frame range visible when the download begins, honoring network
 * backpressure. New frames belong to the next download. Concurrent retention
 * must cause an interrupted stream rather than a valid but incomplete file.
 */
export function exportRequestJournal(
    store: RequestStore,
    request: RequestDetailDto,
    requestId: string,
): Response {
    const snapshot = store.getFrameSummary(request.requestId);
    const encoder = new TextEncoder();
    let started = false;
    let afterSeq = -1;
    let written = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!started) {
                started = true;
                controller.enqueue(encoder.encode(
                    `{"request":${JSON.stringify(request)},"frames":[`,
                ));
                return;
            }
            if (snapshot.lastSeq === null || afterSeq === snapshot.lastSeq) {
                if (written !== snapshot.count) {
                    throw new Error(
                        "request journal changed during export; retry the download",
                    );
                }
                controller.enqueue(encoder.encode("]}"));
                controller.close();
                return;
            }
            const frames = store.listFrames(request.requestId, afterSeq, 500)
                .filter((frame) => frame.seq <= snapshot.lastSeq!);
            if (frames.length === 0) {
                throw new Error(
                    "request journal changed during export; retry the download",
                );
            }
            const json = frames.map((frame) => JSON.stringify(frame)).join(",");
            controller.enqueue(
                encoder.encode(`${written > 0 ? "," : ""}${json}`),
            );
            written += frames.length;
            afterSeq = frames.at(-1)!.seq;
        },
    });
    const filename = `request-${
        request.requestId.replace(/[^a-zA-Z0-9_.-]/g, "_")
    }.json`;
    return new Response(body, {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="${filename}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-heimdall-request-id": requestId,
        },
    });
}

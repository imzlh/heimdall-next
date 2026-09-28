import { assert, assertEquals, assertNotEquals } from "@std/assert";
import type { InferenceSource, OperationRequest } from "@heimdall/contracts";
import type { StreamFrame } from "@heimdall/hip";
import type { ChatMessageRecord, ConversationRecord } from "@heimdall/storage";
import { openSqliteChatStore } from "@heimdall/core/storage/sqlite-chat.ts";
import { createServer } from "../main.ts";

type App = ReturnType<typeof createServer>;
type Store = ReturnType<typeof openSqliteChatStore>;

interface Message extends ChatMessageRecord {
    readonly parentId?: string | null;
    readonly branch?: {
        readonly index: number;
        readonly count: number;
        readonly messageIds: readonly string[];
    };
}

interface Snapshot {
    conversation: ConversationRecord & {
        activeMessageId?: string | null;
        branches?: {
            messageId: string;
            label: string;
            selected: boolean;
        }[];
    };
    messages: Message[];
}

const MODEL = "branch-model";
const ATTACHMENT = { mediaType: "image/png", dataBase64: "aGVsbG8=" };

Deno.test("chat regeneration preserves old variants, descendants and selection across restart", async () => {
    const directory = await Deno.makeTempDir({ prefix: "chat-branches-" });
    const path = `${directory}/chat.sqlite`;
    let store = openSqliteChatStore(path);
    const provider = recordingSource();
    try {
        let app = createServer({ sources: [provider.source], chat: { store } });
        const id = await createConversation(app);
        await send(app, id, "first question");
        await send(app, id, "second question");
        const original = await load(app, id);
        const firstReply = at(original, 1);
        await mutate(app, "regenerate", {
            conversationId: id,
            messageId: firstReply.id,
            model: MODEL,
        });
        const alternate = await load(app, id);
        assertEquals(texts(alternate), ["first question", "reply-3"]);
        const alternativeReply = at(alternate, 1);
        assertEquals(alternativeReply.parentId, at(original, 0).id);
        assertEquals(alternativeReply.branch, {
            index: 1,
            count: 2,
            messageIds: [firstReply.id, alternativeReply.id],
        });
        assertEquals(historyText(provider.requests[2]!), ["first question"]);
        assertPreserved(store, id, original.messages);

        await send(app, id, "follow alternate");
        const alternateWithDescendants = await load(app, id);
        await selectBranch(app, id, firstReply.id);
        assertEquals(
            (await load(app, id)).messages.map((m) => m.id),
            original.messages.map((m) => m.id),
        );
        assertEquals(at(await load(app, id), 1).branch?.index, 0);
        const allIds = store.listAllMessages(id).map((m) => m.id);
        assertEquals(allIds.length, 7);

        store.close();
        store = openSqliteChatStore(path);
        app = createServer({ sources: [provider.source], chat: { store } });
        const reopened = await load(app, id);
        assertEquals(
            reopened.messages.map((m) => m.id),
            original.messages.map((m) => m.id),
        );
        assertEquals(reopened.conversation.activeMessageId, at(original, 3).id);
        assertEquals(store.listAllMessages(id).map((m) => m.id), allIds);
        await selectBranch(app, id, alternativeReply.id);
        const restoredAlternate = await load(app, id);
        assertEquals(
            restoredAlternate.messages.map((m) => m.id),
            alternateWithDescendants.messages.map((m) => m.id),
        );
        assertParentChain(restoredAlternate);
    } finally {
        store.close();
        await Deno.remove(directory, { recursive: true });
    }
});

Deno.test("chat edits arbitrary user and assistant messages as independent variants", async () => {
    const store = openSqliteChatStore(":memory:");
    const provider = recordingSource();
    const app = createServer({ sources: [provider.source], chat: { store } });
    try {
        const id = await createConversation(app);
        await send(app, id, "original question", [ATTACHMENT]);
        await send(app, id, "later question");
        const original = await load(app, id);
        await mutate(app, "message", {
            conversationId: id,
            messageId: at(original, 0).id,
            text: "edited question",
            model: MODEL,
        }, "PATCH");
        const userEdit = await load(app, id);
        assertEquals(texts(userEdit), ["edited question", "reply-3"]);
        assertNotEquals(at(userEdit, 0).id, at(original, 0).id);
        assertEquals(at(userEdit, 0).parentId, null);
        assertEquals(at(userEdit, 0).attachments, [ATTACHMENT]);
        assertEquals(at(userEdit, 0).branch?.messageIds, [
            at(original, 0).id,
            at(userEdit, 0).id,
        ]);
        assertEquals(historyText(provider.requests[2]!), ["edited question"]);
        assertPreserved(store, id, original.messages);

        // Editing an inactive assistant neither calls the model nor replaces its subtree.
        await mutate(app, "message", {
            conversationId: id,
            messageId: at(original, 1).id,
            text: "manually corrected reply",
        }, "PATCH");
        const assistantEdit = await load(app, id);
        assertEquals(texts(assistantEdit), [
            "original question",
            "manually corrected reply",
        ]);
        assertEquals(provider.requests.length, 3);
        assertEquals(at(assistantEdit, 1).status, "completed");
        assertEquals(at(assistantEdit, 1).parentId, at(original, 0).id);
        assertPreserved(store, id, original.messages);
        assertPreserved(store, id, userEdit.messages);
        await selectBranch(app, id, at(original, 1).id);
        assertEquals(
            (await load(app, id)).messages.map((m) => m.id),
            original.messages.map((m) => m.id),
        );
        await selectBranch(app, id, at(userEdit, 0).id);
        assertEquals(
            (await load(app, id)).messages.map((m) => m.id),
            userEdit.messages.map((m) => m.id),
        );
    } finally {
        store.close();
    }
});

Deno.test("chat continuation merges into an assistant variant using only its prefix history", async () => {
    const store = openSqliteChatStore(":memory:");
    const provider = recordingSource();
    const app = createServer({ sources: [provider.source], chat: { store } });
    try {
        const id = await createConversation(app);
        await send(app, id, "first question");
        await send(app, id, "later question");
        const original = await load(app, id);
        await mutate(app, "continue", {
            conversationId: id,
            messageId: at(original, 1).id,
            model: MODEL,
        });
        const continued = await load(app, id);
        assertEquals(texts(continued), ["first question", "reply-1reply-3"]);
        assertEquals(historyText(provider.requests[2]!), [
            "first question",
            "reply-1",
        ]);
        assertNotEquals(at(continued, 1).id, at(original, 1).id);
        assertEquals(at(continued, 1).parentId, at(original, 0).id);
        assertEquals(at(continued, 1).branch?.count, 2);
        assertEquals(
            store.listAllMessages(id).filter((m) => m.role === "user").length,
            2,
        );
        assertPreserved(store, id, original.messages);

        await mutate(app, "continue", { conversationId: id, model: MODEL });
        const continuedAgain = await load(app, id);
        assertEquals(texts(continuedAgain), [
            "first question",
            "reply-1reply-3reply-4",
        ]);
        assertEquals(historyText(provider.requests[3]!), [
            "first question",
            "reply-1reply-3",
        ]);
        assertEquals(at(continuedAgain, 1).branch?.count, 3);
        await selectBranch(app, id, at(original, 1).id);
        assertEquals(
            (await load(app, id)).messages.map((m) => m.id),
            original.messages.map((m) => m.id),
        );
    } finally {
        store.close();
    }
});

Deno.test("chat forks an inactive prefix with fresh ids, attachments and conversation settings", async () => {
    const store = openSqliteChatStore(":memory:");
    const provider = recordingSource();
    const app = createServer({ sources: [provider.source], chat: { store } });
    try {
        const id = await createConversation(app);
        await mutate(app, `conversation?id=${id}`, {
            systemPrompt: "Use short answers.",
            reasoningEffort: "high",
        }, "PATCH");
        await send(app, id, "original question", [ATTACHMENT]);
        await send(app, id, "later question");
        const original = await load(app, id);
        await mutate(app, "regenerate", {
            conversationId: id,
            messageId: at(original, 1).id,
            model: MODEL,
        });
        const selected = await load(app, id);
        const fork = await mutate(
            app,
            "fork",
            {
                conversationId: id,
                messageId: at(original, 1).id,
                title: "独立分支",
            },
            "POST",
            201,
        );
        const forkId = fork.conversation.id;
        assertNotEquals(forkId, id);
        const copied = await load(app, forkId);
        assertEquals(copied.conversation.title, "独立分支");
        assertEquals(copied.conversation.systemPrompt, "Use short answers.");
        assertEquals(copied.conversation.reasoningEffort, "high");
        assertEquals(texts(copied), ["original question", "reply-1"]);
        assertEquals(at(copied, 0).attachments, [ATTACHMENT]);
        assertEquals(at(copied, 1).status, at(original, 1).status);
        assert(
            copied.messages.every((m) =>
                !original.messages.some((old) => old.id === m.id)
            ),
        );
        assert(copied.messages.every((m) => m.conversationId === forkId));
        assertParentChain(copied);
        assertEquals(store.listAllMessages(forkId).length, 2);
        assertEquals(provider.requests.length, 3);
        assertEquals(await load(app, id), selected);
        await send(app, forkId, "fork followup");
        assertEquals(await load(app, id), selected);
        assertEquals(texts(await load(app, forkId)), [
            "original question",
            "reply-1",
            "fork followup",
            "reply-4",
        ]);
    } finally {
        store.close();
    }
});

Deno.test("chat branch mutations reject foreign message ids before changing either conversation", async () => {
    const store = openSqliteChatStore(":memory:");
    const provider = recordingSource();
    const app = createServer({ sources: [provider.source], chat: { store } });
    try {
        const first = await createConversation(app);
        const second = await createConversation(app);
        await send(app, first, "first private history");
        await send(app, second, "second private history");
        const beforeFirst = await load(app, first);
        const beforeSecond = await load(app, second);
        const beforeConversations = store.listConversations();
        for (
            const [route, method] of [
                ["continue", "POST"],
                ["regenerate", "POST"],
                ["message", "PATCH"],
                ["branch", "POST"],
                ["fork", "POST"],
            ]
        ) {
            const response = await request(app, route!, {
                conversationId: first,
                messageId: at(beforeSecond, 1).id,
                text: "unauthorized replacement",
                model: MODEL,
            }, method!);
            assertEquals(response.status, 404, `${method} ${route}`);
            assertEquals((await response.json()).error.code, "not_found");
        }
        assertEquals(await load(app, first), beforeFirst);
        assertEquals(await load(app, second), beforeSecond);
        assertEquals(store.listConversations(), beforeConversations);
        assertEquals(provider.requests.length, 2);
        assertEquals(store.listAllMessages(first).length, 2);
        assertEquals(store.listAllMessages(second).length, 2);
    } finally {
        store.close();
    }
});

Deno.test("chat conversation branch menu restores and forks every surviving path after an earlier turn is deleted", async () => {
    const store = openSqliteChatStore(":memory:");
    const provider = recordingSource();
    const app = createServer({ sources: [provider.source], chat: { store } });
    try {
        const id = await createConversation(app);
        await send(app, id, "first question");
        await send(app, id, "later question");
        const original = await load(app, id);
        assertEquals(original.conversation.branches, undefined);
        await mutate(app, "message", {
            conversationId: id,
            messageId: at(original, 0).id,
            text: "edited first question",
            model: MODEL,
        }, "PATCH");
        const edited = await load(app, id);
        await mutate(app, "regenerate", {
            conversationId: id,
            messageId: at(original, 1).id,
            model: MODEL,
        });
        const alternate = await load(app, id);
        await selectBranch(app, id, at(original, 1).id);
        const removed = await request(
            app,
            `message?conversationId=${id}&id=${at(original, 0).id}`,
            {},
            "DELETE",
        );
        assertEquals(removed.status, 200);
        assertEquals(
            (await removed.json()).ids,
            original.messages.slice(0, 2).map((m) => m.id),
        );

        const current = await load(app, id);
        assertEquals(
            current.messages.map((m) => m.id),
            original.messages.slice(2).map((m) => m.id),
        );
        assertEquals(texts(current), ["later question", "reply-2"]);
        const expectedPaths = [
            original.messages.slice(2),
            alternate.messages.slice(1),
            edited.messages,
        ];
        const leaves = expectedPaths.map((path) => path.at(-1)!);
        const menu = current.conversation.branches;
        assert(menu !== undefined);
        assertEquals(
            menu.map((branch) => branch.messageId).sort(),
            leaves.map((leaf) => leaf.id).sort(),
        );
        assertEquals(
            menu.filter((branch) => branch.selected).map((branch) =>
                branch.messageId
            ),
            [at(original, 3).id],
        );
        for (const branch of menu) {
            assertEquals(
                branch.label,
                leaves.find((leaf) => leaf.id === branch.messageId)?.text,
            );
        }
        // Reparenting the second turn creates another root user and a root
        // assistant. The menu, not a false per-message variant, reaches them.
        assertEquals(
            store.listAllMessages(id).filter((m) => m.branch !== undefined),
            [],
        );

        for (const path of expectedPaths) {
            const leafId = path.at(-1)!.id;
            const choice = menu.find((branch) => branch.messageId === leafId);
            assert(choice !== undefined);
            await selectBranch(app, id, choice.messageId);
            const selected = await load(app, id);
            assertEquals(
                selected.messages.map((m) => m.id),
                path.map((m) => m.id),
            );
            assertEquals(
                selected.messages.map((m) => m.text),
                path.map((m) => m.text),
            );
            assertEquals(
                selected.messages.filter((m) => m.branch !== undefined),
                [],
            );
            assertParentChain(selected);
            assertEquals(
                selected.conversation.branches?.filter((branch) =>
                    branch.selected
                )
                    .map((branch) => branch.messageId),
                [leafId],
            );
            assertEquals(
                selected.conversation.branches?.map((branch) =>
                    branch.messageId
                ).sort(),
                menu.map((branch) => branch.messageId).sort(),
            );

            const fork = await mutate(
                app,
                "fork",
                {
                    conversationId: id,
                    messageId: choice.messageId,
                },
                "POST",
                201,
            );
            const copied = await load(app, fork.conversation.id);
            assertEquals(
                copied.messages.map((m) => [m.role, m.text]),
                path.map((m) => [m.role, m.text]),
            );
            assert(
                copied.messages.every((m) =>
                    !path.some((source) => source.id === m.id)
                ),
            );
            assertParentChain(copied);
            assertEquals(copied.conversation.branches, undefined);
            assertEquals(await load(app, id), selected);
        }
        assertEquals(provider.requests.length, 4);
        assertEquals(store.listAllMessages(id).length, 5);
    } finally {
        store.close();
    }
});

Deno.test("chat branch mutations share the generation lock across HTTP mounts and WebSocket", async () => {
    const store = openSqliteChatStore(":memory:");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const provider = recordingSource({
        beforeReply: async (call) => {
            if (call !== 2) return;
            entered.resolve();
            await release.promise;
        },
    });
    const app = createServer({ sources: [provider.source], chat: { store } });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        app.fetch,
    );
    let socket: ChatSocket | undefined;
    let pending: Promise<Response> | undefined;
    try {
        const id = await createConversation(app);
        await send(app, id, "question");
        const original = await load(app, id);
        const payload = {
            conversationId: id,
            messageId: at(original, 1).id,
            model: MODEL,
            text: "replacement",
        };
        pending = request(app, "continue", payload);
        await within(entered.promise, "blocked continuation");
        for (const prefix of ["/api/chat", "/admin/chat/api"]) {
            for (
                const [route, method] of [
                    ["continue", "POST"],
                    ["regenerate", "POST"],
                    ["message", "PATCH"],
                    ["branch", "POST"],
                    ["fork", "POST"],
                ]
            ) {
                const rejected = await request(
                    app,
                    route!,
                    payload,
                    method!,
                    prefix,
                );
                assertEquals(rejected.status, 409, `${prefix}/${route}`);
                assertEquals(
                    (await rejected.json()).error.code,
                    "run_in_progress",
                );
            }
        }
        socket = await openSocket(server);
        for (const type of ["continue", "regenerate", "edit"]) {
            socket.socket.send(JSON.stringify({ ...payload, type }));
            const rejected = await socket.next();
            assertEquals(rejected.type, "error");
            assertEquals(rejected.status, 409);
            assertEquals(rejected.code, "run_in_progress");
        }
        assertEquals(await load(app, id), original);
        assertEquals(store.listAllMessages(id).length, 2);
        assertEquals(provider.requests.length, 2);
        release.resolve();
        assertEquals((await pending).status, 200);
        await (await pending).json();
        await selectBranch(app, id, at(original, 1).id);
        assertEquals(texts(await load(app, id)), ["question", "reply-1"]);
    } finally {
        release.resolve();
        await pending;
        await socket?.close();
        await server.shutdown();
        store.close();
    }
});

Deno.test("chat branch actions reject invalid roles and user edits without a model atomically", async () => {
    const store = openSqliteChatStore(":memory:");
    const provider = recordingSource();
    const app = createServer({ sources: [provider.source], chat: { store } });
    try {
        const id = await createConversation(app);
        await send(app, id, "question");
        const userId = at(await load(app, id), 0).id;
        const callId = crypto.randomUUID();
        const resultId = crypto.randomUUID();
        store.addMessage({
            id: callId,
            conversationId: id,
            role: "assistant",
            text: "{}",
            callId: "plugin-call",
            name: "plugin_tool",
            createdAt: new Date().toISOString(),
        });
        store.addMessage({
            id: resultId,
            conversationId: id,
            role: "tool",
            text: "plugin result",
            callId: "plugin-call",
            name: "plugin_tool",
            createdAt: new Date().toISOString(),
        });
        const before = await load(app, id);
        for (const messageId of [callId, resultId]) {
            for (
                const [route, method] of [
                    ["continue", "POST"],
                    ["regenerate", "POST"],
                    ["message", "PATCH"],
                ]
            ) {
                const rejected = await request(app, route!, {
                    conversationId: id,
                    messageId,
                    model: MODEL,
                    text: "invalid edit",
                }, method!);
                assertEquals(rejected.status, 400, `${method} ${route}`);
                await rejected.json();
            }
        }
        for (const route of ["continue", "regenerate"]) {
            const rejected = await request(app, route, {
                conversationId: id,
                messageId: userId,
                model: MODEL,
            });
            assertEquals(rejected.status, 400);
            await rejected.json();
        }
        const missingModel = await request(app, "message", {
            conversationId: id,
            messageId: userId,
            text: "edited question",
        }, "PATCH");
        assertEquals(missingModel.status, 400);
        await missingModel.json();
        assertEquals(await load(app, id), before);
        assertEquals(store.listAllMessages(id).length, 4);
        assertEquals(provider.requests.length, 1);
    } finally {
        store.close();
    }
});

Deno.test("chat HTTP and WebSocket continuation, regeneration and edits persist equivalent branches", async () => {
    const httpStore = openSqliteChatStore(":memory:");
    const wsStore = openSqliteChatStore(":memory:");
    const httpProvider = recordingSource();
    const wsProvider = recordingSource();
    const httpApp = createServer({
        sources: [httpProvider.source],
        chat: { store: httpStore },
    });
    const wsApp = createServer({
        sources: [wsProvider.source],
        chat: { store: wsStore },
    });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        wsApp.fetch,
    );
    let socket: ChatSocket | undefined;
    try {
        const httpId = await createConversation(httpApp);
        const wsId = await createConversation(wsApp);
        await send(httpApp, httpId, "original");
        await send(wsApp, wsId, "original");
        const httpOriginal = await load(httpApp, httpId);
        const wsOriginal = await load(wsApp, wsId);
        socket = await openSocket(server);
        for (
            const action of [
                {
                    type: "continue",
                    route: "continue",
                    method: "POST",
                    target: 1,
                },
                {
                    type: "regenerate",
                    route: "regenerate",
                    method: "POST",
                    target: 1,
                },
                {
                    type: "edit",
                    route: "message",
                    method: "PATCH",
                    target: 0,
                    text: "edited user",
                },
                {
                    type: "edit",
                    route: "message",
                    method: "PATCH",
                    target: 1,
                    text: "edited assistant",
                },
            ]
        ) {
            const body = {
                model: MODEL,
                ...(action.text ? { text: action.text } : {}),
            };
            await mutate(httpApp, action.route, {
                ...body,
                conversationId: httpId,
                messageId: at(httpOriginal, action.target).id,
            }, action.method);
            socket.socket.send(JSON.stringify({
                ...body,
                type: action.type,
                conversationId: wsId,
                messageId: at(wsOriginal, action.target).id,
            }));
            const events = await untilDone(socket);
            assertEquals(events.at(-1)?.type, "done");
            if (action.type === "continue") {
                assertEquals(
                    events.filter((e) => e.type === "delta").map((e) => e.text),
                    ["reply-1", "reply-2"],
                );
                assertEquals(events.filter((e) => e.type === "user"), []);
            }
            assertEquals(
                visibleContent(await load(wsApp, wsId)),
                visibleContent(await load(httpApp, httpId)),
            );
            assertEquals(
                wsStore.listAllMessages(wsId).length,
                httpStore.listAllMessages(httpId).length,
            );
            assertEquals(
                wsProvider.requests.map(historyText),
                httpProvider.requests.map(historyText),
            );
        }
        assertPreserved(httpStore, httpId, httpOriginal.messages);
        assertPreserved(wsStore, wsId, wsOriginal.messages);
    } finally {
        await socket?.close();
        await server.shutdown();
        httpStore.close();
        wsStore.close();
    }
});

Deno.test("failed chat continuation preserves the original subtree and the partial extended variant", async () => {
    const store = openSqliteChatStore(":memory:");
    const provider = recordingSource({ failedCall: 3 });
    const app = createServer({ sources: [provider.source], chat: { store } });
    try {
        const id = await createConversation(app);
        await send(app, id, "first question");
        await send(app, id, "later question");
        const original = await load(app, id);
        const failed = await request(app, "continue", {
            conversationId: id,
            messageId: at(original, 1).id,
            model: MODEL,
        });
        assertEquals(failed.status, 502);
        await failed.json();
        const partial = await load(app, id);
        assertEquals(texts(partial), ["first question", "reply-1reply-3"]);
        assertEquals(at(partial, 1).status, "failed");
        assertEquals(at(partial, 1).error?.code, "upstream_error");
        assertPreserved(store, id, original.messages);
        await selectBranch(app, id, at(original, 1).id);
        assertEquals(
            (await load(app, id)).messages.map((m) => m.id),
            original.messages.map((m) => m.id),
        );
        await mutate(app, "message", {
            conversationId: id,
            messageId: at(partial, 1).id,
            text: "corrected partial reply",
        }, "PATCH");
        const edited = at(await load(app, id), 1);
        assertEquals(edited.status, "completed");
        assertEquals(edited.error, undefined);
        assertEquals(provider.requests.length, 3);
        assertPreserved(store, id, partial.messages);
    } finally {
        store.close();
    }
});

function recordingSource(options: {
    beforeReply?: (call: number) => Promise<void>;
    failedCall?: number;
} = {}): { source: InferenceSource; requests: OperationRequest[] } {
    const requests: OperationRequest[] = [];
    return {
        requests,
        source: {
            id: "branch-source",
            capabilities: [{
                operation: "generation.create",
                models: [MODEL],
                streaming: true,
            }],
            async *execute(input): AsyncIterable<StreamFrame> {
                requests.push(input);
                const call = requests.length;
                yield frame(input, 1, { kind: "run.started", request: input });
                await options.beforeReply?.(call);
                yield frame(input, 2, {
                    kind: "part.delta",
                    messageId: "m",
                    partId: "p",
                    delta: `reply-${call}`,
                });
                yield frame(
                    input,
                    3,
                    options.failedCall === call
                        ? {
                            kind: "run.error",
                            error: {
                                code: "upstream_error",
                                message: "provider failed after output",
                            },
                        }
                        : { kind: "run.completed" },
                );
            },
        },
    };
}

function frame(
    input: OperationRequest,
    seq: number,
    event: StreamFrame["event"],
): StreamFrame {
    return {
        version: 1,
        streamId: input.requestId,
        requestId: input.requestId,
        seq,
        eventId: `${input.requestId}-${seq}`,
        timestamp: new Date().toISOString(),
        event,
    };
}

function historyText(request: OperationRequest): string[] {
    const payload = request.payload as unknown as {
        messages: { parts: { type: string; text?: string }[] }[];
    };
    return payload.messages.map((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => p.text).join("")
    );
}

async function createConversation(app: App): Promise<string> {
    const id =
        (await mutate(app, "conversations", {}, "POST", 201)).conversation
            .id;
    // Branch fixtures count model calls and gate a specific generation. A named
    // conversation keeps the separately tested automatic title call out of them.
    await mutate(
        app,
        `conversation?id=${id}`,
        { title: "branch test" },
        "PATCH",
    );
    return id;
}

async function send(
    app: App,
    id: string,
    text: string,
    attachments?: readonly typeof ATTACHMENT[],
): Promise<void> {
    await mutate(app, "message", {
        conversationId: id,
        model: MODEL,
        text,
        ...(attachments ? { attachments } : {}),
    });
}

async function selectBranch(
    app: App,
    conversationId: string,
    messageId: string,
): Promise<void> {
    await mutate(app, "branch", { conversationId, messageId });
}

async function request(
    app: App,
    route: string,
    body: Record<string, unknown>,
    method = "POST",
    prefix = "/api/chat",
): Promise<Response> {
    return await app.request(`http://localhost${prefix}/${route}`, {
        method,
        headers: {
            "content-type": "application/json",
            origin: "http://localhost",
        },
        body: JSON.stringify(body),
    });
}

async function mutate(
    app: App,
    route: string,
    body: Record<string, unknown>,
    method = "POST",
    status = 200,
): Promise<Snapshot> {
    const response = await request(app, route, body, method);
    const result = await response.json();
    assertEquals(
        response.status,
        status,
        `${method} ${route}: ${JSON.stringify(result)}`,
    );
    return result;
}

async function load(app: App, id: string): Promise<Snapshot> {
    const response = await app.request(
        `http://localhost/api/chat/conversation?id=${id}`,
    );
    assertEquals(response.status, 200);
    return await response.json();
}

function at(snapshot: Snapshot, index: number): Message {
    const message = snapshot.messages[index];
    assert(message !== undefined, `missing message ${index}`);
    return message;
}

function texts(snapshot: Snapshot): string[] {
    return snapshot.messages.map((m) => m.text);
}

function assertParentChain(snapshot: Snapshot): void {
    snapshot.messages.forEach((m, index) => {
        assertEquals(
            m.parentId,
            index === 0 ? null : snapshot.messages[index - 1]!.id,
        );
    });
    assertEquals(
        snapshot.conversation.activeMessageId,
        snapshot.messages.at(-1)?.id ?? null,
    );
}

function assertPreserved(
    store: Store,
    id: string,
    messages: readonly Message[],
): void {
    const all = store.listAllMessages(id);
    for (const before of messages) {
        const saved = all.find((m) => m.id === before.id);
        assert(saved, `message ${before.id} was deleted`);
        assertEquals(saved.text, before.text);
        assertEquals(saved.parentId, before.parentId);
        assertEquals(saved.attachments, before.attachments);
        assertEquals(saved.status, before.status);
        assertEquals(saved.error, before.error);
    }
}

function visibleContent(snapshot: Snapshot): unknown {
    return snapshot.messages.map((m) => ({
        role: m.role,
        text: m.text,
        status: m.status,
        error: m.error,
        parentIndex: snapshot.messages.findIndex((parent) =>
            parent.id === m.parentId
        ),
        branchIndex: m.branch?.index ?? 0,
        branchCount: m.branch?.count ?? 1,
    }));
}

interface SocketEvent {
    type: string;
    text?: string;
    status?: number;
    code?: string;
}

interface ChatSocket {
    socket: WebSocket;
    next(): Promise<SocketEvent>;
    close(): Promise<void>;
}

async function openSocket(server: Deno.HttpServer): Promise<ChatSocket> {
    const port = (server.addr as Deno.NetAddr).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/chat/socket`, [
        "heimdall-chat",
    ]);
    const queue: SocketEvent[] = [];
    let waiter: ((message: SocketEvent) => void) | undefined;
    const closed = Promise.withResolvers<void>();
    socket.addEventListener("close", () => closed.resolve());
    socket.addEventListener("message", (event) => {
        const message: SocketEvent = JSON.parse(String(event.data));
        if (waiter === undefined) queue.push(message);
        else {
            const resolve = waiter;
            waiter = undefined;
            resolve(message);
        }
    });
    await within(
        new Promise<void>((resolve, reject) => {
            socket.addEventListener("open", () => resolve(), { once: true });
            socket.addEventListener(
                "error",
                () => reject(new Error("socket failed")),
                { once: true },
            );
        }),
        "socket opening",
    ).catch((error) => {
        socket.close();
        throw error;
    });
    return {
        socket,
        next() {
            const queued = queue.shift();
            return queued === undefined
                ? within(
                    new Promise<SocketEvent>((resolve) => {
                        waiter = resolve;
                    }),
                    "socket message",
                )
                : Promise.resolve(queued);
        },
        async close() {
            if (socket.readyState < WebSocket.CLOSING) socket.close();
            await within(closed.promise, "socket close");
        },
    };
}

async function untilDone(socket: ChatSocket): Promise<SocketEvent[]> {
    const messages: SocketEvent[] = [];
    for (let count = 0; count < 20; count++) {
        const message = await socket.next();
        messages.push(message);
        if (message.type === "done" || message.type === "error") {
            return messages;
        }
    }
    throw new Error("socket did not finish the branch action");
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`${label} timed out`)),
                    5_000,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

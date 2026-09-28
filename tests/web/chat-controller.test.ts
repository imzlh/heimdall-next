import { assert, assertEquals } from "@std/assert";
import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import type {
    ChatCommand,
    ChatConversation,
    ChatEvent,
    ChatMessage,
    ChatStream,
} from "@heimdall/core/web/client/api/chat.ts";
import { createChatController } from "@heimdall/core/web/client/chat/controller.ts";
import type {
    ChatApi,
    ChatController,
    ChatState,
} from "@heimdall/core/web/client/chat/types.ts";
import {
    readStoredDraft,
    writeStoredDraft,
} from "@heimdall/core/web/client/chat/drafts.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
function waitForState(
    controller: ChatController,
    predicate: (state: ChatState) => boolean,
): Promise<void> {
    if (predicate(controller.getState())) return Promise.resolve();
    return new Promise((resolve) => {
        const unsubscribe = controller.subscribe((state) => {
            if (!predicate(state)) return;
            unsubscribe();
            resolve();
        });
    });
}
function conversation(id = "one"): ChatConversation {
    return {
        id,
        title: id,
        createdAt: "2026-09-24T00:00:00Z",
        updatedAt: "2026-09-24T00:00:00Z",
    };
}
function message(
    id: string,
    role: ChatMessage["role"],
    text: string,
    conversationId = "one",
): ChatMessage {
    return {
        id,
        role,
        text,
        conversationId,
        createdAt: "2026-09-24T00:00:00Z",
    };
}
function asset(name = "first.png") {
    const assetId = `asset_${name.replace(/\./g, "_")}`;
    return {
        assetId,
        mediaType: "image/png",
        size: 1,
        name,
        url: `/admin/chat/api/assets/${assetId}`,
        leaseId: `lease_${assetId}`,
    };
}
/** Draft and model persistence live in localStorage; isolate it per test. */
function clearChatStorage() {
    try {
        const storage = globalThis.localStorage;
        if (!storage) return;
        storage.removeItem("heimdall.chat.models");
        for (let index = storage.length - 1; index >= 0; index--) {
            const key = storage.key(index);
            if (key?.startsWith("heimdall.chat.draft.")) {
                storage.removeItem(key);
            }
        }
    } catch { /* Isolation is best-effort. */ }
}

function initial(patch: Partial<ChatInitial> = {}): ChatInitial {
    clearChatStorage();
    return {
        conversations: [conversation()],
        conversation: conversation(),
        messages: [],
        models: ["model-a", "model-b"],
        authenticated: true,
        available: true,
        ...patch,
    };
}
class FakeStream implements ChatStream {
    readonly completion = deferred<"done" | "stopped">();
    readonly finished = this.completion.promise;
    stops = 0;
    closes = 0;
    constructor(readonly onEvent: (event: ChatEvent) => void) {}
    emit(event: ChatEvent) {
        this.onEvent(event);
    }
    stop() {
        this.stops++;
    }
    close() {
        this.closes++;
        this.completion.reject(new Error("closed"));
    }
}
function fakeApi() {
    const streams: FakeStream[] = [];
    const commands: ChatCommand[] = [];
    const loads: string[] = [];
    const deleted: Array<[string, string]> = [];
    const released: Array<[string, string]> = [];
    let persisted: ChatMessage[] = [];
    let created = 0;
    let listed = 0;
    const api: ChatApi = {
        list() {
            listed++;
            return Promise.resolve([conversation()]);
        },
        create() {
            created++;
            return Promise.resolve(conversation("created"));
        },
        rename(id, title) {
            return Promise.resolve({ ...conversation(id), title });
        },
        updateSettings(id, patch) {
            return Promise.resolve({
                ...conversation(id),
                ...(patch.systemPrompt === undefined
                    ? {}
                    : { systemPrompt: patch.systemPrompt }),
                ...(patch.reasoningEffort === undefined ||
                        patch.reasoningEffort === null
                    ? {}
                    : { reasoningEffort: patch.reasoningEffort }),
            });
        },
        remove() {
            return Promise.resolve();
        },
        deleteMessage(conversationId, messageId) {
            deleted.push([conversationId, messageId]);
            return Promise.resolve([messageId]);
        },
        switchBranch(id) {
            return Promise.resolve({
                conversation: conversation(id),
                messages: persisted,
            });
        },
        fork() {
            return Promise.resolve({
                conversation: conversation("forked"),
                messages: persisted.map((item) => ({
                    ...item,
                    conversationId: "forked",
                })),
            });
        },
        async upload(file) {
            await file.arrayBuffer();
            return asset(file.name);
        },
        acquireAttachment(assetId) {
            return Promise.resolve({ ...asset(), assetId });
        },
        releaseAttachment(assetId, leaseId) {
            released.push([assetId, leaseId]);
            return Promise.resolve();
        },
        load(id) {
            loads.push(id);
            return Promise.resolve({
                conversation: conversation(id),
                messages: persisted,
            });
        },
        open(command, onEvent) {
            commands.push(command);
            const stream = new FakeStream(onEvent);
            streams.push(stream);
            return stream;
        },
    };
    return {
        api,
        streams,
        commands,
        loads,
        deleted,
        released,
        setPersisted(value: ChatMessage[]) {
            persisted = value;
        },
        created: () => created,
        listed: () => listed,
    };
}

Deno.test("chat controller keeps SSR state without refetching or replaying on construction", () => {
    const fake = fakeApi();
    const saved = [message("saved", "assistant", "SSR reply")];
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    assertEquals(controller.getState().messages, saved);
    assertEquals(controller.getState().model, "model-a");
    assertEquals(fake.loads, []);
    assertEquals(fake.listed(), 0);
    assertEquals(fake.commands, []);
    controller.dispose();
});

Deno.test("chat controller sends once, clears only acknowledged draft, then uses persisted history", async () => {
    const fake = fakeApi();
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    controller.setModel("model-b");
    controller.setDraft("hello");
    const sent = controller.send();
    await controller.send();
    assertEquals(fake.commands, [{
        type: "send",
        conversationId: "one",
        model: "model-b",
        text: "hello",
    }]);
    assertEquals(controller.getState().draft, "hello");
    const stream = fake.streams[0]!;
    const user = message("user-1", "user", "hello");
    stream.emit({ type: "user", message: user });
    stream.emit({ type: "user", message: user });
    assertEquals(controller.getState().draft, "");
    assertEquals(controller.getState().messages, [user]);
    controller.setDraft("next draft");
    stream.emit({ type: "delta", text: "first " });
    stream.emit({ type: "delta", text: "second" });
    const call = { callId: "call-1", name: "plugin-tool", argumentsText: "{}" };
    stream.emit({ type: "tool", calls: [call] });
    stream.emit({ type: "tool", calls: [call] });
    assertEquals(controller.getState().streamText, "first second");
    assertEquals(controller.getState().toolCalls, [call]);
    const saved = [user, message("reply", "assistant", "canonical reply")];
    fake.setPersisted(saved);
    stream.completion.resolve("done");
    await sent;
    assertEquals(controller.getState().messages, saved);
    assertEquals(controller.getState().streamText, "");
    assertEquals(controller.getState().toolCalls, []);
    assertEquals(controller.getState().draft, "next draft");
    assertEquals(controller.getState().sending, false);
    assertEquals(fake.loads, ["one"]);
    assertEquals(fake.listed(), 1);
    controller.dispose();
});

Deno.test("chat failed stream reloads persisted history without dropping unacknowledged edits or replaying", async () => {
    const fake = fakeApi();
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    controller.setDraft("unacknowledged");
    const sent = controller.send();
    controller.setDraft("newer draft");
    fake.setPersisted([message("saved", "user", "unacknowledged")]);
    fake.streams[0]!.completion.reject(new Error("generation failed"));
    await sent;
    assertEquals(controller.getState().draft, "newer draft");
    assertEquals(controller.getState().messages[0]?.id, "saved");
    assertEquals(controller.getState().error, "generation failed");
    assertEquals(fake.commands.length, 1);
    controller.dispose();
});

Deno.test("chat a late selection cannot replace the latest conversation or its draft", async () => {
    const fake = fakeApi();
    const first = deferred<
        { conversation: ChatConversation; messages: ChatMessage[] }
    >();
    const second = deferred<
        { conversation: ChatConversation; messages: ChatMessage[] }
    >();
    const signals: AbortSignal[] = [];
    fake.api.load = (id, signal) => {
        signals.push(signal!);
        return id === "two" ? first.promise : second.promise;
    };
    const selected: string[] = [];
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
        onSelect: (id) => selected.push(id),
    });
    controller.setDraft("draft in one");
    const a = controller.select("two");
    controller.setDraft("draft kept in one");
    const b = controller.select("three");
    assert(signals[0]!.aborted);
    second.resolve({
        conversation: conversation("three"),
        messages: [message("three", "user", "three", "three")],
    });
    await b;
    first.resolve({
        conversation: conversation("two"),
        messages: [message("two", "user", "two", "two")],
    });
    await a;
    assertEquals(controller.getState().selectedId, "three");
    assertEquals(controller.getState().messages[0]?.id, "three");
    assertEquals(controller.getState().draft, "");
    assertEquals(selected, ["three"]);
    controller.setDraft("draft in three");
    fake.api.load = () => Promise.reject(new Error("offline"));
    await controller.select("two");
    assertEquals(controller.getState().selectedId, "three");
    assertEquals(controller.getState().conversation?.id, "three");
    assertEquals(controller.getState().messages[0]?.id, "three");
    assertEquals(controller.getState().draft, "draft in three");
    assert(controller.getState().error.includes("offline"));
    controller.dispose();
});

Deno.test("chat navigation closes an active run and ignores its late events and final reload", async () => {
    const fake = fakeApi();
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    controller.setDraft("hello");
    const sent = controller.send();
    const stream = fake.streams[0]!;
    await controller.select("two");
    stream.emit({ type: "delta", text: "stale output" });
    await sent;
    assertEquals(stream.closes, 1);
    assertEquals(controller.getState().selectedId, "two");
    assertEquals(controller.getState().streamText, "");
    assertEquals(fake.loads, ["two"]);
    assertEquals(controller.getState().sending, false);
    controller.dispose();
});

Deno.test("chat stop is idempotent and waits for persisted history after the acknowledgement", async () => {
    const fake = fakeApi();
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    controller.setDraft("hello");
    const sent = controller.send();
    const stream = fake.streams[0]!;
    controller.stop();
    controller.stop();
    assertEquals(stream.stops, 1);
    assertEquals(controller.getState().stopping, true);
    assertEquals(controller.getState().sending, true);
    stream.completion.resolve("stopped");
    await sent;
    assertEquals(controller.getState().stopping, false);
    assertEquals(controller.getState().sending, false);
    assertEquals(fake.loads, ["one"]);
    controller.dispose();
});

Deno.test("chat sending a new conversation creates once and stop before create resolves never sends", async () => {
    const fake = fakeApi();
    const created = deferred<ChatConversation>();
    let createCount = 0;
    fake.api.create = () => {
        createCount++;
        return created.promise;
    };
    const selected: string[] = [];
    const controller = createChatController({
        initial: initial({ conversation: null, messages: [] }),
        api: fake.api,
        onSelect: (id) => selected.push(id),
    });
    controller.setDraft("keep this draft");
    const sent = controller.send();
    await controller.send();
    controller.stop();
    created.resolve(conversation("created"));
    await sent;
    assertEquals(createCount, 1);
    assertEquals(fake.commands, []);
    assertEquals(controller.getState().draft, "keep this draft");
    assertEquals(controller.getState().selectedId, "created");
    assertEquals(selected, ["created"]);
    controller.dispose();
});

Deno.test("chat effort chosen before the first message rides onto the created conversation", async () => {
    const fake = fakeApi();
    const savedSettings: Array<[string, string]> = [];
    const updateSettings = fake.api.updateSettings.bind(fake.api);
    fake.api.updateSettings = (id, patch, signal) => {
        if (typeof patch.reasoningEffort === "string") {
            savedSettings.push([id, patch.reasoningEffort]);
        }
        return updateSettings(id, patch, signal);
    };
    const controller = createChatController({
        initial: initial({
            conversations: [],
            conversation: null,
            messages: [],
        }),
        api: fake.api,
    });
    assertEquals(controller.getState().pendingEffort, "medium");
    controller.chooseEffort("high");
    assertEquals(controller.getState().pendingEffort, "high");
    controller.setDraft("hello");
    const sent = controller.send();
    await waitForState(controller, (state) => state.selectedId === "created");
    assertEquals(savedSettings, [["created", "high"]]);
    assertEquals(controller.getState().pendingEffort, "medium");
    assertEquals(controller.getState().conversation?.reasoningEffort, "high");
    const stream = fake.streams[0]!;
    stream.completion.resolve("done");
    await sent;
    assertEquals(fake.commands[0]?.type, "send");
    controller.dispose();
});

Deno.test("chat effort chosen with a selected conversation persists immediately", async () => {
    const fake = fakeApi();
    const savedSettings: Array<[string, string]> = [];
    const updateSettings = fake.api.updateSettings.bind(fake.api);
    fake.api.updateSettings = (id, patch, signal) => {
        if (typeof patch.reasoningEffort === "string") {
            savedSettings.push([id, patch.reasoningEffort]);
        }
        return updateSettings(id, patch, signal);
    };
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    controller.chooseEffort("low");
    await waitForState(
        controller,
        (state) => state.conversation?.reasoningEffort === "low",
    );
    assertEquals(savedSettings, [["one", "low"]]);
    controller.dispose();
});

Deno.test("chat regenerate uses the selected model and replaces the latest assistant only after reload", async () => {
    const fake = fakeApi();
    const user = message("user", "user", "question");
    const previous = message("old", "assistant", "old answer");
    const controller = createChatController({
        initial: initial({ messages: [user, previous] }),
        api: fake.api,
    });
    controller.setDraft("unsent question");
    const regenerated = controller.regenerate();
    assertEquals(fake.commands, [{
        type: "regenerate",
        conversationId: "one",
        model: "model-a",
    }]);
    assertEquals(controller.getState().messages, [user, previous]);
    fake.setPersisted([user, message("new", "assistant", "new answer")]);
    fake.streams[0]!.completion.resolve("done");
    await regenerated;
    assertEquals(controller.getState().messages[1]?.id, "new");
    assertEquals(controller.getState().draft, "unsent question");
    controller.dispose();
});

Deno.test("chat reload failure preserves partial output and never clears draft", async () => {
    const fake = fakeApi();
    fake.api.load = () => Promise.reject(new Error("history unavailable"));
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    controller.setDraft("hello");
    const sent = controller.send();
    const stream = fake.streams[0]!;
    stream.emit({ type: "delta", text: "partial reply" });
    stream.completion.reject(new Error("disconnected"));
    await sent;
    assertEquals(controller.getState().streamText, "partial reply");
    assertEquals(controller.getState().draft, "hello");
    assert(controller.getState().error.includes("disconnected"));
    assert(controller.getState().error.includes("history unavailable"));
    controller.dispose();
});

Deno.test("chat dispose cancels the stream, unsubscribes and prevents stale notifications", async () => {
    const fake = fakeApi();
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    let notifications = 0;
    controller.subscribe(() => notifications++);
    controller.setDraft("hello");
    const sent = controller.send();
    const stream = fake.streams[0]!;
    controller.dispose();
    const count = notifications;
    stream.emit({ type: "delta", text: "late" });
    controller.setDraft("ignored");
    await sent;
    assertEquals(notifications, count);
    assertEquals(stream.closes, 1);
    assertEquals(fake.loads, []);
    controller.dispose();
});

Deno.test("chat refuses unavailable, unauthenticated, empty and unknown-model writes", async () => {
    const fake = fakeApi();
    for (const patch of [{ available: false }, { authenticated: false }]) {
        const controller = createChatController({
            initial: initial(patch),
            api: fake.api,
        });
        controller.setDraft("hello");
        await controller.send();
        await controller.create();
        controller.dispose();
    }
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    await controller.send();
    assertEquals(controller.getState().error, "请输入消息内容");
    await controller.regenerate();
    assert(controller.getState().error.includes("重新生成"));
    controller.setDraft("hello");
    controller.setModel("missing");
    await controller.send();
    assertEquals(controller.getState().error, "请选择可用模型");
    assertEquals(fake.commands, []);
    assertEquals(fake.created(), 0);
    controller.dispose();
});

Deno.test("chat keeps newly selected images when acknowledgement clears the sent attachments", async () => {
    const fake = fakeApi();
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    const first = new File([new Uint8Array([1])], "first.png", {
        type: "image/png",
    });
    await controller.addAttachments([first]);
    controller.setDraft("describe the first picture");
    const sent = controller.send();
    assertEquals(fake.commands[0]?.type, "send");
    assertEquals(
        fake.commands[0] && "attachments" in fake.commands[0]
            ? fake.commands[0].attachments
            : [],
        [asset()],
    );
    const bytes = deferred<ArrayBuffer>();
    const second = new File([new Uint8Array([2])], "second.png", {
        type: "image/png",
    });
    Object.defineProperty(second, "arrayBuffer", {
        value: () => bytes.promise,
    });
    const attached = controller.addAttachments([second]);
    const stream = fake.streams[0]!;
    stream.emit({
        type: "user",
        message: message("user-ack", "user", "describe the first picture"),
    });
    assertEquals(controller.getState().attachments, []);
    controller.setDraft("describe this one next");
    bytes.resolve(new Uint8Array([2]).buffer);
    await attached;
    assertEquals(controller.getState().attachments, [asset("second.png")]);
    assertEquals(controller.getState().draft, "describe this one next");
    stream.completion.resolve("done");
    await sent;
    controller.dispose();
});

Deno.test("chat rename updates history and current title without disturbing messages or drafts", async () => {
    const fake = fakeApi();
    const saved = [message("saved", "assistant", "reply")];
    const rename = deferred<ChatConversation>();
    const calls: string[][] = [];
    fake.api.rename = (id, title) => {
        calls.push([id, title]);
        return rename.promise;
    };
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    controller.setDraft("unsent");
    const changed = controller.rename("one", "  新名称  ");
    assertEquals(controller.getState().managing, true);
    await controller.select("two");
    await controller.create();
    await controller.send();
    assertEquals(fake.loads, []);
    assertEquals(fake.created(), 0);
    assertEquals(fake.commands, []);
    assertEquals(await controller.remove("one"), false);
    rename.resolve({ ...conversation(), title: "新名称" });
    assertEquals(await changed, true);
    assertEquals(calls, [["one", "新名称"]]);
    assertEquals(controller.getState().conversation?.title, "新名称");
    assertEquals(controller.getState().conversations[0]?.title, "新名称");
    assertEquals(controller.getState().messages, saved);
    assertEquals(controller.getState().draft, "unsent");
    assertEquals(controller.getState().managing, false);
    controller.dispose();
});

Deno.test("chat failed management preserves the selection, messages, list and attachments", async () => {
    const fake = fakeApi();
    let renames = 0;
    fake.api.rename = () => {
        renames++;
        return Promise.reject(new Error("offline"));
    };
    fake.api.remove = () => Promise.reject(new Error("run_in_progress"));
    const saved = [message("saved", "assistant", "reply")];
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    controller.setDraft("unsent");
    await controller.addAttachments([
        new File([new Uint8Array([1])], "image.png", { type: "image/png" }),
    ]);
    const before = controller.getState();
    assertEquals(await controller.rename("one", " "), false);
    assertEquals(await controller.rename("one", "x".repeat(121)), false);
    assertEquals(renames, 0);
    assertEquals(await controller.rename("one", "valid"), false);
    assertEquals(await controller.remove("one"), false);
    const after = controller.getState();
    for (
        const key of [
            "selectedId",
            "conversation",
            "messages",
            "conversations",
            "draft",
            "attachments",
        ] as const
    ) {
        assertEquals(after[key], before[key]);
    }
    assert(after.error.includes("run_in_progress"));
    assertEquals(after.managing, false);
    controller.dispose();
});

Deno.test("chat refuses conversation mutations until the active generation is settled", async () => {
    const fake = fakeApi();
    let mutations = 0;
    fake.api.rename = (id, title) => {
        mutations++;
        return Promise.resolve({ ...conversation(id), title });
    };
    fake.api.remove = () => {
        mutations++;
        return Promise.resolve();
    };
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    controller.setDraft("question");
    const sent = controller.send();
    assertEquals(await controller.rename("one", "title"), false);
    assertEquals(await controller.remove("one"), false);
    controller.stop();
    assertEquals(await controller.remove("one"), false);
    assertEquals(mutations, 0);
    fake.streams[0]!.completion.resolve("stopped");
    await sent;
    assertEquals(await controller.rename("one", "title"), true);
    assertEquals(mutations, 1);
    controller.dispose();
});

Deno.test("chat deleting a background conversation leaves current history and draft untouched", async () => {
    const fake = fakeApi();
    const saved = [message("saved", "assistant", "reply")];
    const controller = createChatController({
        initial: initial({
            conversations: [conversation(), conversation("two")],
            messages: saved,
        }),
        api: fake.api,
    });
    controller.setDraft("unsent");
    assertEquals(await controller.remove("two"), true);
    assertEquals(controller.getState().selectedId, "one");
    assertEquals(controller.getState().messages, saved);
    assertEquals(controller.getState().draft, "unsent");
    assertEquals(controller.getState().conversations.map((item) => item.id), [
        "one",
    ]);
    assertEquals(fake.loads, []);
    controller.dispose();
});

Deno.test("chat deleting current conversation selects its neighbour and last deletion clears the location", async () => {
    const fake = fakeApi();
    const selected: string[] = [];
    const controller = createChatController({
        initial: initial({
            conversations: [conversation(), conversation("two")],
        }),
        api: fake.api,
        onSelect: (id) => selected.push(id),
    });
    controller.setDraft("discarded with deleted conversation");
    assertEquals(await controller.remove("one"), true);
    assertEquals(controller.getState().selectedId, "two");
    assertEquals(controller.getState().draft, "");
    assertEquals(controller.getState().conversations.map((item) => item.id), [
        "two",
    ]);
    controller.setDraft("also discarded");
    assertEquals(await controller.remove("two"), true);
    assertEquals(controller.getState().selectedId, "");
    assertEquals(controller.getState().conversation, null);
    assertEquals(controller.getState().conversations, []);
    assertEquals(controller.getState().messages, []);
    assertEquals(controller.getState().draft, "");
    assertEquals(selected, ["", "two", ""]);
    controller.dispose();
});

Deno.test("chat successful deletion stays deleted if loading the next conversation fails", async () => {
    const fake = fakeApi();
    fake.api.load = () => Promise.reject(new Error("offline"));
    const controller = createChatController({
        initial: initial({
            conversations: [conversation(), conversation("two")],
        }),
        api: fake.api,
    });
    assertEquals(await controller.remove("one"), true);
    assertEquals(controller.getState().conversations.map((item) => item.id), [
        "two",
    ]);
    assertEquals(controller.getState().selectedId, "");
    assertEquals(controller.getState().messages, []);
    assert(controller.getState().error.includes("offline"));
    assertEquals(controller.getState().loading, false);
    assertEquals(controller.getState().managing, false);
    controller.dispose();
});

Deno.test("chat disposal aborts an outstanding mutation and ignores its late result", async () => {
    const fake = fakeApi();
    const rename = deferred<ChatConversation>();
    let signal: AbortSignal | undefined;
    fake.api.rename = (_id, _title, abort) => {
        signal = abort;
        return rename.promise;
    };
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    const pending = controller.rename("one", "renamed");
    controller.dispose();
    assert(signal?.aborted);
    rename.resolve({ ...conversation(), title: "renamed" });
    assertEquals(await pending, false);
    assertEquals(controller.getState().conversation?.title, "one");
});

Deno.test("chat controller deletes a single message and drops it locally", async () => {
    const fake = fakeApi();
    const reply = message("m2", "assistant", "你好！");
    const saved = [message("m1", "user", "你好"), reply];
    fake.setPersisted([reply]);
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    assertEquals(await controller.removeMessage("one", "m1"), true);
    assertEquals(fake.deleted, [["one", "m1"]]);
    assertEquals(controller.getState().messages, [reply]);
    assertEquals(controller.getState().managing, false);
    controller.dispose();
});

Deno.test("chat controller keeps the message and reports the error when deletion fails", async () => {
    const fake = fakeApi();
    fake.api.deleteMessage = () => Promise.reject(new Error("offline"));
    const saved = [message("m1", "user", "你好")];
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    assertEquals(await controller.removeMessage("one", "m1"), false);
    assertEquals(controller.getState().messages, saved);
    assert(controller.getState().error.includes("offline"));
    assertEquals(controller.getState().managing, false);
    controller.dispose();
});

Deno.test("chat continues the existing answer without adding a user or consuming the draft", async () => {
    const fake = fakeApi();
    const user = message("u1", "user", "question");
    const previous = {
        ...message("a1", "assistant", "half"),
        status: "stopped" as const,
    };
    const controller = createChatController({
        initial: initial({ messages: [user, previous] }),
        api: fake.api,
    });
    controller.setDraft("my next question");
    const pending = controller.continueMessage("a1");
    assertEquals(fake.commands, [{
        type: "continue",
        conversationId: "one",
        model: "model-a",
        messageId: "a1",
    }]);
    assertEquals(controller.getState().messages, [user, previous]);
    fake.streams[0]!.emit({ type: "delta", text: "half" });
    fake.streams[0]!.emit({ type: "delta", text: " and the rest" });
    assertEquals(controller.getState().messages, [user]);
    assertEquals(controller.getState().streamText, "half and the rest");
    const saved = [user, {
        ...message("a2", "assistant", "half and the rest"),
        branch: { index: 1, count: 2, messageIds: ["a1", "a2"] },
    }];
    fake.setPersisted(saved);
    fake.streams[0]!.completion.resolve("done");
    await pending;
    assertEquals(controller.getState().messages, saved);
    assertEquals(controller.getState().draft, "my next question");
    controller.dispose();
});

Deno.test("chat editing is acknowledged before generation finishes and leaves the composer draft alone", async () => {
    const fake = fakeApi();
    const user = message("u1", "user", "old question");
    const reply = message("a1", "assistant", "old reply");
    const controller = createChatController({
        initial: initial({ messages: [user, reply] }),
        api: fake.api,
    });
    controller.setDraft("unsent question");
    const accepted = controller.editMessage("u1", "new question");
    assertEquals(fake.commands[0], {
        type: "edit",
        conversationId: "one",
        messageId: "u1",
        model: "model-a",
        text: "new question",
    });
    assertEquals(controller.getState().messages, [user, reply]);
    const edited = message("u2", "user", "new question");
    fake.streams[0]!.emit({ type: "user", message: edited });
    assertEquals(await accepted, true);
    assertEquals(controller.getState().sending, true);
    assertEquals(controller.getState().messages, [edited]);
    assertEquals(controller.getState().draft, "unsent question");
    fake.setPersisted([edited, message("a2", "assistant", "new reply")]);
    fake.streams[0]!.completion.resolve("done");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assertEquals(controller.getState().sending, false);
    controller.dispose();
});

Deno.test("chat failed edit keeps history and dialog text can be retried without replay", async () => {
    const fake = fakeApi();
    const saved = [message("u1", "user", "original")];
    fake.setPersisted(saved);
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    const accepted = controller.editMessage("u1", "edited");
    fake.streams[0]!.completion.reject(new Error("conflict"));
    assertEquals(await accepted, false);
    assertEquals(controller.getState().messages, saved);
    assertEquals(fake.commands.length, 1);
    assertEquals(controller.getState().error, "conflict");
    controller.dispose();
});

Deno.test("chat regenerates an earlier assistant from its own position and preserves later history until accepted", async () => {
    const fake = fakeApi();
    const saved = [
        message("u1", "user", "one"),
        message("a1", "assistant", "first"),
        message("u2", "user", "two"),
        message("a2", "assistant", "second"),
    ];
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    const pending = controller.regenerate("a1");
    assertEquals(fake.commands[0], {
        type: "regenerate",
        conversationId: "one",
        model: "model-a",
        messageId: "a1",
    });
    assertEquals(controller.getState().messages, saved);
    fake.streams[0]!.emit({ type: "delta", text: "new first" });
    assertEquals(controller.getState().messages, [saved[0]!]);
    fake.setPersisted([saved[0]!, message("a3", "assistant", "new first")]);
    fake.streams[0]!.completion.resolve("done");
    await pending;
    assertEquals(controller.getState().messages[1]?.id, "a3");
    controller.dispose();
});

Deno.test("chat switches complete branch histories and forks into a new selected conversation", async () => {
    const fake = fakeApi();
    const original = [
        message("u1", "user", "one"),
        message("a1", "assistant", "first"),
    ];
    const alternate = [
        original[0]!,
        message("a2", "assistant", "alternate"),
        message("u2", "user", "follow-up"),
    ];
    const controller = createChatController({
        initial: initial({ messages: original }),
        api: fake.api,
    });
    controller.setDraft("draft on original");
    fake.setPersisted(alternate);
    assertEquals(await controller.switchBranch("a2"), true);
    assertEquals(controller.getState().messages, alternate);
    assertEquals(controller.getState().draft, "draft on original");
    controller.setModel("model-b");
    assertEquals(await controller.forkMessage("a2"), true);
    assertEquals(controller.getState().selectedId, "forked");
    assertEquals(controller.getState().model, "model-b");
    assertEquals(controller.getState().draft, "");
    assertEquals(controller.getState().conversations[0]?.id, "forked");
    await controller.select("one");
    assertEquals(controller.getState().draft, "draft on original");
    controller.dispose();
});

Deno.test("chat branch changes cannot race a generation and failed mutations preserve the visible path", async () => {
    const fake = fakeApi();
    const saved = [
        message("u1", "user", "one"),
        message("a1", "assistant", "reply"),
    ];
    let mutations = 0;
    fake.api.switchBranch = () => {
        mutations++;
        return Promise.reject(new Error("offline"));
    };
    const controller = createChatController({
        initial: initial({ messages: saved }),
        api: fake.api,
    });
    assertEquals(await controller.switchBranch("a2"), false);
    assertEquals(controller.getState().messages, saved);
    controller.setDraft("next");
    const pending = controller.send();
    assertEquals(await controller.switchBranch("a2"), false);
    assertEquals(mutations, 1);
    fake.streams[0]!.completion.resolve("done");
    await pending;
    controller.dispose();
});

Deno.test("chat reference images reuse the saved asset without upload and enforce the draft limit", async () => {
    const fake = fakeApi();
    fake.api.upload = () => {
        throw new Error("reference must not upload");
    };
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    await controller.addReference(asset());
    await controller.addReference(asset());
    assertEquals(controller.getState().attachments, [asset()]);
    await controller.addReference({
        mediaType: "image/png",
        dataBase64: "AA==",
    });
    assertEquals(controller.getState().attachments.length, 1);
    for (const name of ["two.png", "three.png", "four.png", "five.png"]) {
        await controller.addReference(asset(name));
    }
    assertEquals(controller.getState().attachments.length, 4);
    assert(controller.getState().error.includes("4"));
    controller.dispose();
});

Deno.test("chat navigation aborts image uploads and late completion cannot enter another draft", async () => {
    const fake = fakeApi();
    const uploaded = deferred<ReturnType<typeof asset>>();
    let signal: AbortSignal | undefined;
    fake.api.upload = (_file, abort) => {
        signal = abort;
        return uploaded.promise;
    };
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    const pending = controller.addAttachments([
        new File(["x"], "first.png", { type: "image/png" }),
    ]);
    await controller.select("two");
    assert(signal?.aborted);
    uploaded.resolve(asset());
    await pending;
    assertEquals(controller.getState().selectedId, "two");
    assertEquals(controller.getState().attachments, []);
    assertEquals(controller.getState().attachmentsBusy, false);
    assertEquals(fake.released, [[asset().assetId, asset().leaseId]]);
    controller.dispose();
});

Deno.test("chat persists image references with draft text and releases an explicitly removed image", async () => {
    const fake = fakeApi();
    const seed = initial();
    const controller = createChatController({ initial: seed, api: fake.api });
    controller.setDraft("remember this picture");
    await controller.addReference(asset());
    controller.dispose();
    const restored = createChatController({ initial: seed, api: fake.api });
    assertEquals(restored.getState().draft, "remember this picture");
    const { url: _url, ...storedAsset } = asset();
    assertEquals(restored.getState().attachments, [storedAsset]);
    assertEquals(fake.released, []);
    await waitForState(restored, (state) => !state.attachmentsBusy);
    restored.removeAttachment(0);
    assertEquals(fake.released, [[asset().assetId, asset().leaseId]]);
    assertEquals(restored.getState().attachments, []);
    restored.dispose();
});

Deno.test("chat releases successful uploads when another selected image fails", async () => {
    const fake = fakeApi();
    fake.api.upload = (file) =>
        file.name === "bad.png"
            ? Promise.reject(new Error("upload failed"))
            : Promise.resolve(asset());
    const controller = createChatController({
        initial: initial(),
        api: fake.api,
    });
    await controller.addAttachments([
        new File(["x"], "first.png", { type: "image/png" }),
        new File(["x"], "bad.png", { type: "image/png" }),
    ]);
    assertEquals(controller.getState().attachments, []);
    assertEquals(fake.released, [[asset().assetId, asset().leaseId]]);
    assertEquals(controller.getState().error, "upload failed");
    controller.dispose();
});

Deno.test("chat failed continuation does not duplicate the unchanged saved prefix", async () => {
    for (const extra of ["", " unsaved extension"]) {
        const fake = fakeApi();
        const saved = [
            message("u1", "user", "question"),
            message("a1", "assistant", "original"),
        ];
        fake.setPersisted(saved);
        const controller = createChatController({
            initial: initial({ messages: saved }),
            api: fake.api,
        });
        const pending = controller.continueMessage("a1");
        fake.streams[0]!.emit({ type: "delta", text: "original" });
        if (extra) fake.streams[0]!.emit({ type: "delta", text: extra });
        fake.streams[0]!.completion.reject(new Error("upstream failed"));
        await pending;
        assertEquals(controller.getState().messages, saved);
        assertEquals(
            controller.getState().streamText,
            extra ? "original" + extra : "",
        );
        controller.dispose();
    }
});

Deno.test("chat renews restored images before sending and never releases consumed leases", async () => {
    const fake = fakeApi();
    const seed = initial();
    const old = asset();
    writeStoredDraft("one", { text: "restored question", attachments: [old] });
    const pendingLease = deferred<ReturnType<typeof asset>>();
    const acquired: string[] = [];
    fake.api.acquireAttachment = (id) => {
        acquired.push(id);
        return pendingLease.promise;
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    assertEquals(acquired, [old.assetId]);
    assertEquals(controller.getState().draft, "restored question");
    assertEquals(controller.getState().attachmentsBusy, true);
    await controller.send();
    assertEquals(fake.commands, []);
    controller.setDraft("edited during recovery");
    const fresh = { ...old, leaseId: "fresh_lease" };
    pendingLease.resolve(fresh);
    await waitForState(controller, (state) => !state.attachmentsBusy);
    assertEquals(controller.getState().draft, "edited during recovery");
    assertEquals(controller.getState().attachments, [fresh]);
    assertEquals(readStoredDraft("one").attachments[0]?.leaseId, "fresh_lease");
    const sent = controller.send();
    assertEquals(fake.commands, [{
        type: "send",
        conversationId: "one",
        text: "edited during recovery",
        model: "model-a",
        attachments: [fresh],
    }]);
    const accepted = {
        ...message("u1", "user", "edited during recovery"),
        attachments: [{ ...old, leaseId: undefined }],
    };
    fake.streams[0]!.emit({ type: "user", message: accepted });
    fake.setPersisted([accepted]);
    fake.streams[0]!.completion.resolve("done");
    await sent;
    assertEquals(controller.getState().attachments, []);
    assertEquals(readStoredDraft("one"), { text: "", attachments: [] });
    await controller.remove("one");
    controller.dispose();
    assertEquals(fake.released, []);
});

Deno.test("chat failed restoration keeps the full draft and retries with new leases on send", async () => {
    const fake = fakeApi();
    const seed = initial();
    const old = [asset(), asset("second.png")];
    writeStoredDraft("one", { text: "keep both images", attachments: old });
    const saved = readStoredDraft("one");
    let recovering = false;
    let attempts = 0;
    const partial = { ...old[0]!, leaseId: "partial_lease" };
    fake.api.acquireAttachment = (id) => {
        attempts++;
        return recovering
            ? Promise.resolve({
                ...old.find((item) => item.assetId === id)!,
                leaseId: `recovered_${id}`,
            })
            : id === old[0]!.assetId
            ? Promise.resolve(partial)
            : Promise.reject(new Error("offline"));
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    await waitForState(controller, (state) => !state.attachmentsBusy);
    assertEquals(controller.getState().draft, saved.text);
    assertEquals(controller.getState().attachments, saved.attachments);
    assertEquals(readStoredDraft("one"), saved);
    assert(controller.getState().error.includes("offline"));
    assertEquals(fake.released, [[partial.assetId, partial.leaseId]]);
    // An explicit failed retry must not send another tab's stored lease.
    await controller.send();
    assertEquals(fake.commands, []);
    assertEquals(attempts, 4);
    recovering = true;
    const sent = controller.send();
    await waitForState(controller, (state) => state.sending);
    assertEquals(attempts, 6);
    const command = fake.commands[0]!;
    assert(command.type === "send");
    assertEquals(
        command.attachments?.map((item) => item.leaseId),
        old.map((item) => `recovered_${item.assetId}`),
    );
    assertEquals(controller.getState().error, "");
    fake.streams[0]!.emit({
        type: "user",
        message: message("accepted", "user", saved.text),
    });
    fake.streams[0]!.completion.resolve("done");
    await sent;
    controller.dispose();
    assert(fake.released.every(([, lease]) => lease === "partial_lease"));
});

Deno.test("chat returning to a conversation renews its draft without taking a late lease from prior navigation", async () => {
    const fake = fakeApi();
    const seed = initial({
        conversations: [conversation(), conversation("two")],
    });
    const old = asset();
    writeStoredDraft("one", { text: "first draft", attachments: [old] });
    writeStoredDraft("two", { text: "second draft", attachments: [] });
    const first = deferred<ReturnType<typeof asset>>();
    const second = deferred<ReturnType<typeof asset>>();
    const released = deferred<void>();
    fake.api.releaseAttachment = (id, lease) => {
        fake.released.push([id, lease]);
        released.resolve();
        return Promise.resolve();
    };
    const signals: AbortSignal[] = [];
    fake.api.acquireAttachment = (_id, signal) => {
        signals.push(signal!);
        return signals.length === 1 ? first.promise : second.promise;
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    await controller.select("two");
    assert(signals[0]!.aborted);
    const late = { ...old, leaseId: "late_navigation" };
    first.resolve(late);
    // Selecting the old conversation starts a separate restoration while the
    // cancelled acquisition is deliberately still completing.
    const returned = controller.select("one");
    await waitForState(controller, (state) => state.attachmentsBusy);
    await released.promise;
    assertEquals(fake.released, [[late.assetId, late.leaseId]]);
    const fresh = { ...old, leaseId: "current_navigation" };
    second.resolve(fresh);
    await returned;
    assertEquals(controller.getState().selectedId, "one");
    assertEquals(controller.getState().draft, "first draft");
    assertEquals(controller.getState().attachments, [fresh]);
    await controller.select("two");
    assertEquals(controller.getState().draft, "second draft");
    assertEquals(controller.getState().attachments, []);
    controller.dispose();
});

Deno.test("chat deleting a conversation during restoration releases late acquisitions only", async () => {
    const fake = fakeApi();
    const seed = initial({
        conversations: [conversation(), conversation("two")],
    });
    const old = asset();
    writeStoredDraft("one", { text: "deleted draft", attachments: [old] });
    const acquisition = deferred<ReturnType<typeof asset>>();
    let signal: AbortSignal | undefined;
    fake.api.acquireAttachment = (_id, abort) => {
        signal = abort;
        return acquisition.promise;
    };
    const released = deferred<void>();
    fake.api.releaseAttachment = (id, lease) => {
        fake.released.push([id, lease]);
        released.resolve();
        return Promise.resolve();
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    assertEquals(await controller.remove("one"), true);
    assert(signal?.aborted);
    assertEquals(controller.getState().selectedId, "two");
    const fresh = { ...old, leaseId: "late_delete" };
    acquisition.resolve(fresh);
    await released.promise;
    assertEquals(fake.released, [[fresh.assetId, fresh.leaseId]]);
    assertEquals(controller.getState().draft, "");
    assertEquals(controller.getState().attachments, []);
    assertEquals(readStoredDraft("one"), { text: "", attachments: [] });
    controller.dispose();
});

Deno.test("chat disposing during restoration releases new leases and leaves the stored draft intact", async () => {
    const fake = fakeApi();
    const seed = initial();
    const old = asset();
    writeStoredDraft("one", { text: "next visit", attachments: [old] });
    const saved = readStoredDraft("one");
    const acquisition = deferred<ReturnType<typeof asset>>();
    let signal: AbortSignal | undefined;
    fake.api.acquireAttachment = (_id, abort) => {
        signal = abort;
        return acquisition.promise;
    };
    const released = deferred<void>();
    fake.api.releaseAttachment = (id, lease) => {
        fake.released.push([id, lease]);
        released.resolve();
        return Promise.resolve();
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    controller.dispose();
    assert(signal?.aborted);
    const fresh = { ...old, leaseId: "late_dispose" };
    acquisition.resolve(fresh);
    await released.promise;
    assertEquals(fake.released, [[fresh.assetId, fresh.leaseId]]);
    assertEquals(readStoredDraft("one"), saved);
    assertEquals(controller.getState().attachments, saved.attachments);
});

Deno.test("chat tabs restoring the same draft independently own and release their own leases", async () => {
    const seed = initial();
    const old = asset();
    writeStoredDraft("one", { text: "shared", attachments: [old] });
    const fakeA = fakeApi();
    const fakeB = fakeApi();
    const pendingA = deferred<ReturnType<typeof asset>>();
    const pendingB = deferred<ReturnType<typeof asset>>();
    fakeA.api.acquireAttachment = () => pendingA.promise;
    fakeB.api.acquireAttachment = () => pendingB.promise;
    const tabA = createChatController({ initial: seed, api: fakeA.api });
    const tabB = createChatController({ initial: seed, api: fakeB.api });
    const leaseA = { ...old, leaseId: "tab_a" };
    const leaseB = { ...old, leaseId: "tab_b" };
    pendingA.resolve(leaseA);
    pendingB.resolve(leaseB);
    await Promise.all([
        waitForState(tabA, (state) => !state.attachmentsBusy),
        waitForState(tabB, (state) => !state.attachmentsBusy),
    ]);
    tabA.removeAttachment(0);
    assertEquals(fakeA.released, [[old.assetId, "tab_a"]]);
    assertEquals(fakeB.released, []);
    assertEquals(tabB.getState().attachments, [leaseB]);
    tabB.removeAttachment(0);
    assertEquals(fakeB.released, [[old.assetId, "tab_b"]]);
    tabA.dispose();
    tabB.dispose();
});

Deno.test("chat deleting an unvisited stored draft never releases the lease owned by another tab", async () => {
    const fake = fakeApi();
    const seed = initial({
        conversations: [conversation(), conversation("two")],
    });
    writeStoredDraft("two", { text: "another tab", attachments: [asset()] });
    let acquired = 0;
    fake.api.acquireAttachment = () => {
        acquired++;
        return Promise.resolve(asset());
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    assertEquals(await controller.remove("two"), true);
    assertEquals(acquired, 0);
    assertEquals(fake.released, []);
    assertEquals(readStoredDraft("two"), { text: "", attachments: [] });
    controller.dispose();
});

Deno.test("chat removing a failed restored image releases only newly added images owned by this controller", async () => {
    const fake = fakeApi();
    const seed = initial();
    const old = asset();
    writeStoredDraft("one", { text: "keep text", attachments: [old] });
    fake.api.acquireAttachment = () => Promise.reject(new Error("offline"));
    const controller = createChatController({ initial: seed, api: fake.api });
    await waitForState(controller, (state) => !state.attachmentsBusy);
    await controller.addAttachments([
        new File(["x"], "new.png", { type: "image/png" }),
    ]);
    controller.removeAttachment(0);
    assertEquals(fake.released, []);
    assertEquals(controller.getState().attachments, [asset("new.png")]);
    controller.removeAttachment(0);
    assertEquals(fake.released, [[
        asset("new.png").assetId,
        asset("new.png").leaseId,
    ]]);
    assertEquals(controller.getState().draft, "keep text");
    controller.dispose();
});

Deno.test("chat removing a restored image cancels recovery and never returns that image to the draft", async () => {
    const fake = fakeApi();
    const seed = initial();
    const old = asset();
    writeStoredDraft("one", { text: "keep text", attachments: [old] });
    const acquisition = deferred<ReturnType<typeof asset>>();
    const released = deferred<void>();
    fake.api.acquireAttachment = () => acquisition.promise;
    fake.api.releaseAttachment = (id, lease) => {
        fake.released.push([id, lease]);
        released.resolve();
        return Promise.resolve();
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    controller.removeAttachment(0);
    assertEquals(fake.released, []);
    const fresh = { ...old, leaseId: "removed_recovery" };
    acquisition.resolve(fresh);
    await released.promise;
    assertEquals(fake.released, [[fresh.assetId, fresh.leaseId]]);
    assertEquals(controller.getState().attachmentsBusy, false);
    assertEquals(controller.getState().attachments, []);
    assertEquals(readStoredDraft("one"), {
        text: "keep text",
        attachments: [],
    });
    controller.dispose();
});

Deno.test("chat restores the anonymous draft before transferring it into a new conversation", async () => {
    const fake = fakeApi();
    const seed = initial({ conversation: null, conversations: [] });
    const old = asset();
    writeStoredDraft("", { text: "first question", attachments: [old] });
    let attempts = 0;
    const fresh = { ...old, leaseId: "anonymous_recovered" };
    fake.api.acquireAttachment = () => {
        attempts++;
        return attempts === 1
            ? Promise.reject(new Error("temporary failure"))
            : Promise.resolve(fresh);
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    await waitForState(controller, (state) => !state.attachmentsBusy);
    await controller.create();
    assertEquals(attempts, 2);
    assertEquals(controller.getState().selectedId, "created");
    assertEquals(controller.getState().attachments, [fresh]);
    assertEquals(controller.getState().draft, "first question");
    assertEquals(readStoredDraft(""), { text: "", attachments: [] });
    assertEquals(
        readStoredDraft("created").attachments[0]?.leaseId,
        fresh.leaseId,
    );
    controller.dispose();
    assertEquals(fake.released, []);
});

Deno.test("chat a send waiting for restoration cannot send after the selected conversation changes", async () => {
    const fake = fakeApi();
    const seed = initial({
        conversations: [conversation(), conversation("two")],
    });
    writeStoredDraft("one", { text: "first", attachments: [asset()] });
    writeStoredDraft("two", { text: "second", attachments: [] });
    let attempts = 0;
    fake.api.acquireAttachment = () => {
        attempts++;
        return attempts === 1
            ? Promise.reject(new Error("offline"))
            : Promise.resolve({
                ...asset(),
                leaseId: "retry_before_navigation",
            });
    };
    const controller = createChatController({ initial: seed, api: fake.api });
    await waitForState(controller, (state) => !state.attachmentsBusy);
    let selected: Promise<void> | undefined;
    const unsubscribe = controller.subscribe((state) => {
        if (state.selectedId === "one" && !state.attachmentsBusy) {
            unsubscribe();
            selected = controller.select("two");
        }
    });
    await controller.send();
    await selected;
    assertEquals(controller.getState().selectedId, "two");
    assertEquals(controller.getState().draft, "second");
    assertEquals(fake.commands, []);
    controller.dispose();
});

Deno.test("chat does not acquire stored images when the initial session is unavailable or unauthenticated", () => {
    for (const patch of [{ authenticated: false }, { available: false }]) {
        const fake = fakeApi();
        const seed = initial(patch);
        writeStoredDraft("one", {
            text: "private draft",
            attachments: [asset()],
        });
        let acquisitions = 0;
        fake.api.acquireAttachment = () => {
            acquisitions++;
            return Promise.resolve(asset());
        };
        const controller = createChatController({
            initial: seed,
            api: fake.api,
        });
        assertEquals(acquisitions, 0);
        assertEquals(controller.getState().attachmentsBusy, false);
        assertEquals(controller.getState().draft, "private draft");
        controller.dispose();
    }
});

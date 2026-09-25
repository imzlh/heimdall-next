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
import type { ChatApi } from "@heimdall/core/web/client/chat/types.ts";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
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
function initial(patch: Partial<ChatInitial> = {}): ChatInitial {
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
        remove() {
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
    assertEquals(controller.getState().messages, [user]);
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
        [{ mediaType: "image/png", dataBase64: "AQ==" }],
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
    assertEquals(controller.getState().attachments, [{
        mediaType: "image/png",
        dataBase64: "Ag==",
    }]);
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

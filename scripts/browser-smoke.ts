/** Real Chrome acceptance against isolated stores and a local upstream. */
import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright-core";
import { loadBuiltinComposition } from "../src/composition/builtins.ts";
import { createServer } from "../src/composition/server.ts";
import { createRuntimeSettings } from "../src/composition/runtime-settings.ts";
import { openSqliteChatStore } from "../src/storage/sqlite-chat.ts";
import { openSqliteChatAssetStore } from "../src/storage/sqlite-assets.ts";
import { ChatAssetService } from "../src/chat/assets.ts";
import { openSqliteRequestStore } from "../src/storage/sqlite-requests.ts";
import { createRequestLifecycle } from "../src/composition/request-lifecycle.ts";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";
import { loadRuntimeUiContributions } from "../src/composition/ui-contributions.ts";
import { loadSourceSchemas } from "../src/composition/source-schemas.ts";
import {
    loadPresetPages,
    withBuiltinPresetPages,
} from "../src/composition/preset-pages.ts";
import { packagePlugin } from "./package-plugin.ts";
import { checkChatComposer } from "./browser-chat-composer.ts";
import type { GenerationRequest, StreamFrame } from "@heimdall/hip";

const output = await Deno.makeTempDir({ prefix: "heimdall-browser-" });
console.log(`Browser artifacts: ${output}`);
using kv = await Deno.openKv(":memory:");
const builtins = await loadBuiltinComposition({
    configStore: new DenoKvConfigStore(kv),
    env: () => undefined,
    runtimeSettings: createRuntimeSettings({
        proxyKey: "",
        limitPerMinute: 0,
        probeIntervalMs: 0,
    }),
});
const chat = openSqliteChatStore(":memory:");
const assets = openSqliteChatAssetStore(":memory:");
const requests = openSqliteRequestStore(":memory:");
let receivedModel = "";
const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
        if (new URL(request.url).pathname.endsWith("/models")) {
            return Response.json({
                object: "list",
                data: [{ id: "upstream-model", object: "model" }],
            });
        }
        const body = await request.json();
        receivedModel = body.model;
        return Response.json({
            id: "browser-completion",
            object: "chat.completion",
            model: body.model,
            choices: [{
                index: 0,
                message: { role: "assistant", content: "映射成功" },
                finish_reason: "stop",
            }],
        });
    },
);
const upstreamUrl = `http://127.0.0.1:${upstream.addr.port}/v1`;
let toolUsed = false;
let finishComposerReply: (() => void) | undefined;
let composerReply: Promise<void> | undefined;
builtins.sources.register({
    id: "browser-fixture",
    capabilities: [{
        operation: "generation.create",
        models: ["test-model"],
        streaming: true,
    }],
    async *execute(request): AsyncIterable<StreamFrame> {
        const payload = request.payload as GenerationRequest;
        const event = (
            seq: number,
            event: StreamFrame["event"],
        ): StreamFrame => ({
            version: 1,
            streamId: "browser-smoke",
            requestId: request.requestId,
            seq,
            eventId: `e${seq}`,
            timestamp: new Date().toISOString(),
            event,
        });
        yield event(1, { kind: "run.started", request });
        const resultPresent = JSON.stringify(payload.messages).includes(
            "浏览器工具结果",
        );
        if (
            payload.tools?.some((tool) => tool.name === "browser_echo") &&
            !resultPresent
        ) {
            yield event(2, {
                kind: "tool.call",
                messageId: "m",
                callId: crypto.randomUUID(),
                name: "browser_echo",
                argumentsText: "{}",
            });
        } else {
            toolUsed ||= resultPresent;
            yield event(2, {
                kind: "part.delta",
                messageId: "m",
                partId: "p",
                delta: "浏览器测试回复",
            });
            if (composerReply) await composerReply;
        }
        yield event(3, { kind: "run.completed" });
    },
});
const policy = withBuiltinPresetPages({});
const app = createServer({
    requestJournal: requests,
    lifecycle: createRequestLifecycle(requests),
    protocols: builtins.protocols,
    middleware: builtins.middleware,
    sourceMiddleware: builtins.sourceMiddleware,
    sourceRegistry: builtins.sources,
    adminCatalog: builtins.catalog,
    adminManagement: builtins.management,
    adminAssetsRoot: "public/assets",
    adminUiContributions: () => loadRuntimeUiContributions(builtins.pluginHost),
    adminUiSourcePlugins: builtins.sourcePluginIds,
    adminUiSchemas: loadSourceSchemas,
    adminUiPolicy: policy,
    adminPresetPages: () => loadPresetPages(policy),
    chat: {
        store: chat,
        tools: builtins.toolPlugins,
        assets: new ChatAssetService(assets),
    },
});
const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => app.fetch(request),
);
const origin = `http://127.0.0.1:${server.addr.port}`;
const failures: string[] = [];
const checks: string[] = [];
let success = false;
let browserVersion = "";
const executablePath = Deno.env.get("HEIMDALL_BROWSER_EXECUTABLE");
let browser;
function track(page: Page) {
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") failures.push(message.text());
    });
    page.on("response", (response) => {
        if (response.status() >= 400) {
            failures.push(`HTTP ${response.status()}: ${response.url()}`);
        }
    });
}
const shot = (page: Page, name: string) =>
    page.screenshot({ path: `${output}/${name}.png`, fullPage: true });
async function beginSource(page: Page, name: string) {
    await page.getByRole("button", { name: "添加渠道", exact: true }).first()
        .click();
    await page.getByLabel("渠道名称", { exact: true }).fill(name);
    await page.getByRole("button", { name: "添加模型映射", exact: true })
        .click();
    await page.locator("input[data-model-alias]").fill(
        name === "预设验收渠道" ? "public-model" : "custom-model",
    );
    await page.locator(".source-model-map-row input").last().fill(
        "upstream-model",
    );
    await page.getByRole("button", { name: "中间件使用方式", exact: true })
        .click();
    await page.getByRole("option", { name: "自定义此渠道", exact: true })
        .click();
    await page.getByRole("button", { name: "下一步", exact: true }).click();
}

try {
    browser = await chromium.launch({
        ...(executablePath ? { executablePath } : { channel: "chrome" }),
        headless: true,
    });
    browserVersion = browser.version();
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: "light",
    });
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    track(page);
    await page.goto(`${origin}/admin?view=channels`);
    await beginSource(page, "预设验收渠道");
    await shot(page, "source-presets");
    await page.getByRole("button", { name: /NewAPI 快速接入/ }).click();
    await page.getByLabel(/^服务地址/).fill(upstreamUrl);
    await page.getByLabel("访问令牌", { exact: true }).fill("browser-test-key");
    assertEquals(
        await page.getByLabel("访问令牌", { exact: true }).getAttribute("type"),
        "password",
    );
    await page.getByRole("button", { name: "测试连接并获取模型", exact: true })
        .click();
    await page.locator(".source-probe-result[data-state=success]").waitFor();
    assertEquals(
        context.pages().length,
        1,
        "Preset must stay inside the original modal",
    );
    await shot(page, "source-preset-form");
    await page.getByRole("button", { name: "保存渠道", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await page.reload();
    await page.getByText("预设验收渠道", { exact: true }).first().waitFor();
    const response = await fetch(`${origin}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            model: "public-model",
            messages: [{ role: "user", content: "验证映射" }],
        }),
    });
    assertEquals(response.status, 200, await response.clone().text());
    const reply = await response.json();
    assertEquals(receivedModel, "upstream-model");
    assertEquals(reply.model, "public-model");
    checks.push("同模态 preset JSX、真实探测与保存、核心模型映射执行");

    await beginSource(page, "自定义验收渠道");
    await page.getByRole("button", { name: /自定义/ }).click();
    await page.getByRole("button", { name: "源类型", exact: true }).click();
    await page.getByRole("option", { name: /OpenAI/ }).click();
    await page.getByLabel(/^服务地址/).fill(upstreamUrl);
    await page.getByRole("button", { name: "保存渠道", exact: true }).click();
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    const catalogResponse = await app.request("/admin/sources");
    const catalog = await catalogResponse.json();
    for (const name of ["预设验收渠道", "自定义验收渠道"]) {
        const source = catalog.sources.find((source: { name: string }) =>
            source.name === name
        );
        assert(source, `Saved source missing: ${name}`);
        assertEquals(source.middleware, []);
        assertEquals(Object.values(source.modelMap), ["upstream-model"]);
    }
    await shot(page, "channels-light");
    await page.getByRole("button", { name: "添加渠道", exact: true }).first()
        .click();
    await page.waitForFunction(() => document.querySelector("dialog:modal"));
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    checks.push("自定义 schema 表单、基础映射/中间件保存、Escape 关闭");

    await page.goto(`${origin}/admin/chat`);
    assertEquals(await page.locator('[data-ui-slot^="chat."]').count(), 0);
    await page.locator("#chat-model").click();
    await page.getByRole("option", { name: "test-model", exact: true }).click();
    await checkChatComposer(page);
    checks.push(
        "图片粘贴/拖放/预览/校验、文字与选区保留、长按 Enter 防重复发送",
    );
    await page.getByRole("button", { name: "对话设置", exact: true }).click();
    const clock = page.getByRole(
        "switch",
        { name: "当前时间", exact: true },
    );
    await clock.click();
    assertEquals(await clock.getAttribute("aria-checked"), "false");
    await page.keyboard.press("Escape");
    await shot(page, "chat-light");
    await page.getByLabel("消息内容", { exact: true }).fill(
        "你好，真实浏览器验证",
    );
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.getByText("浏览器测试回复", { exact: true }).last().waitFor();
    await page.reload();
    await page.getByRole("button", { name: "对话设置", exact: true }).click();
    await clock.waitFor();
    assertEquals(
        await clock.getAttribute("aria-checked"),
        "false",
        "Tool preference must survive reload",
    );
    await page.keyboard.press("Escape");
    checks.push("Chat 工具统一在对话设置中管理、开关随会话持久化、发送回复");
    assertEquals(await page.locator("#chat-model").innerText(), "test-model");

    const admin = await context.newPage();
    track(admin);
    await admin.goto(`${origin}/admin#plugins`);
    const packagePath = `${output}/browser-tool.json`;
    await Deno.writeTextFile(
        packagePath,
        await packagePlugin(
            {
                id: "test.browser-tool",
                name: "浏览器验收工具",
                version: "1.0.0",
                apiVersion: "1",
                kind: "tool",
                trust: "isolated",
                ui: [{
                    pluginId: "test.browser-tool",
                    id: "details",
                    slot: "chat.sidebar",
                    title: "动态工具状态",
                    schema: {
                        blocks: [{ kind: "text", text: "离线插件已就绪" }],
                    },
                }],
            },
            `export function invoke(method) {
        if (method === "tools.list") return [{ name: "browser_echo", description: "本地验收工具", inputSchema: { type: "object" } }];
        if (method === "tools.execute") return { text: "浏览器工具结果", isError: false };
        throw new Error("Unsupported method");
    }`,
        ),
    );
    await admin.getByRole("button", { name: "安装插件", exact: true }).click();
    await admin.getByLabel("JSON 插件包", { exact: true }).setInputFiles(
        packagePath,
    );
    await admin.getByRole("button", { name: "安装插件包", exact: true })
        .click();
    await admin.getByRole("button", {
        name: "启用 浏览器验收工具",
        exact: true,
    }).click();
    await page.bringToFront();
    await page.getByRole("button", { name: "对话设置", exact: true }).click();
    const plugin = page.getByRole(
        "switch",
        { name: "浏览器验收工具", exact: true },
    );
    await plugin.waitFor();
    assertEquals(
        await page.getByText("离线插件已就绪", { exact: true }).count(),
        0,
    );
    await page.keyboard.press("Escape");
    await shot(admin, "plugins");
    await page.getByLabel("消息内容", { exact: true }).fill("调用插件");
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    await page.locator(".chat-message.role-assistant").filter({
        hasText: "浏览器测试回复",
    }).nth(1).waitFor();
    assert(toolUsed, "Chat must invoke the installed Worker");
    await admin.getByRole("button", {
        name: "停用 浏览器验收工具",
        exact: true,
    }).click();
    await page.bringToFront();
    await page.getByRole("button", { name: "对话设置", exact: true }).click();
    await plugin.waitFor({ state: "hidden" });
    await page.getByText("离线插件已就绪", { exact: true }).waitFor({
        state: "hidden",
    });
    await page.keyboard.press("Escape");
    await admin.getByRole("button", {
        name: "卸载 浏览器验收工具",
        exact: true,
    }).click();
    await admin.getByRole("button", { name: "确认卸载", exact: true }).click();
    await admin.getByRole("heading", { name: "浏览器验收工具", exact: true })
        .waitFor({ state: "hidden" });
    checks.push(
        "离线插件安装/启用/真实 Worker 调用/停用/卸载，跨 Tab 对话设置同步",
    );

    // Hold the reply open to type the next message during generation, then
    // verify the final history reload preserves both text and keyboard focus.
    composerReply = new Promise<void>((resolve) => {
        finishComposerReply = resolve;
    });
    const draftInput = page.locator("#chat-draft");
    await draftInput.fill("验证生成期间的下一条草稿");
    await draftInput.press("Enter");
    await page.waitForFunction(() =>
        document.querySelector(".is-streaming .chat-markdown")?.textContent
            ?.includes("浏览器测试回复")
    );
    await draftInput.fill("生成时继续编辑的草稿");
    await draftInput.press("Shift+Enter");
    await draftInput.pressSequentially("保留换行");
    finishComposerReply?.();
    composerReply = undefined;
    await page.waitForFunction(() =>
        document.querySelector(".chat-composer")?.getAttribute(
            "data-sending",
        ) ===
            "false"
    );
    assertEquals(
        await draftInput.inputValue(),
        "生成时继续编辑的草稿\n保留换行",
    );
    assert(
        await draftInput.evaluate((input) => document.activeElement === input),
    );
    checks.push("生成期间继续编辑，回复收尾保留草稿、换行和焦点");

    await page.getByRole("button", { name: "切换为深色主题", exact: true })
        .click();
    await page.waitForFunction(() =>
        document.documentElement.dataset.theme === "dark"
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await shot(page, "chat-dark");
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, "chat-mobile");
    assert(
        await page.evaluate(() =>
            document.documentElement.scrollWidth <= innerWidth + 1
        ),
        "Mobile Chat overflows horizontally",
    );
    const ssr = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: 1440, height: 1000 },
    });
    const staticPage = await ssr.newPage();
    await staticPage.goto(`${origin}/admin/chat`);
    assertEquals(
        await staticPage.locator('[data-ui-slot^="chat."]').count(),
        0,
    );
    await shot(staticPage, "chat-no-js");
    await ssr.close();
    checks.push("深浅色、390px 窄屏、减少动态效果、无 JS 页面不显示重复工具区");
    assertEquals(failures, [], "Browser console errors");
    success = true;
} catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    for (const context of browser?.contexts() ?? []) {
        for (const [index, page] of context.pages().entries()) {
            console.error(
                `Page ${index}:`,
                (await page.locator("body").innerText()).slice(-5000),
            );
            await shot(page, `failure-${index}`);
        }
    }
    throw error;
} finally {
    finishComposerReply?.();
    await Deno.writeTextFile(
        `${output}/result.json`,
        JSON.stringify({ success, browserVersion, checks, failures }, null, 2),
    );
    await browser?.close();
    await server.shutdown();
    await upstream.shutdown();
    await builtins.close();
    chat.close();
    assets.close();
    requests.close();
}
console.log(
    JSON.stringify(
        { success, browserVersion, checks, failures, output },
        null,
        2,
    ),
);

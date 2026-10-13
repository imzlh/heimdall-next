/**
 * Real Chrome acceptance for workspace settings; run after `deno task build:web`:
 * deno run --node-modules-dir=none --unstable-kv --unstable-worker-options -A scripts/browser-workspace-config.ts
 * All fixtures are temporary. Screenshots and result.json remain for review.
 */
import { assert, assertEquals } from "@std/assert";
import type { ToolConfigDto } from "@heimdall/admin-contracts";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    type Browser,
    chromium,
    type Page,
    type Response as BrowserResponse,
} from "playwright-core";
import { loadBuiltinComposition } from "../src/composition/builtins.ts";
import { createServer } from "../src/composition/server.ts";
import { createRuntimeSettings } from "../src/composition/runtime-settings.ts";
import { createRequestLifecycle } from "../src/composition/request-lifecycle.ts";
import { DenoKvConfigStore } from "../src/storage/deno-kv.ts";
import { openSqliteChatStore } from "../src/storage/sqlite-chat.ts";
import { openSqliteRequestStore } from "../src/storage/sqlite-requests.ts";

const pluginId = "heimdall.tool.workspace";
const configureLabel = "配置 本地工作区";
const endpoint = "/api/admin/tool-config";
const bridgeEndpoint = "/admin/ui/request";
const temporary = await Deno.makeTempDir({
    prefix: "heimdall-workspace-browser-",
});
const workspace = join(temporary, "workspace");
const artifacts = join(temporary, "artifacts");
const checks: string[] = [];
const failures: string[] = [];
const consoleErrors: { text: string; url: string; expected: boolean }[] = [];
const screenshots: string[] = [];
let success = false;
let browserVersion = "";
let expectedValidationError = false;
let page: Page | undefined;

function isConfigWrite(response: BrowserResponse): boolean {
    const request = response.request();
    const pathname = new URL(response.url()).pathname;
    if (pathname === endpoint) return request.method() === "PUT";
    if (pathname !== bridgeEndpoint || request.method() !== "POST") {
        return false;
    }
    const envelope = request.postDataJSON();
    return envelope?.path === endpoint && envelope?.method === "PUT";
}

async function launchChrome(): Promise<Browser> {
    try {
        return await chromium.launch({ channel: "chrome", headless: true });
    } catch (channelError) {
        const candidates = Deno.build.os === "windows"
            ? [
                "C:/Program Files/Google/Chrome/Application/chrome.exe",
                "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
            ]
            : Deno.build.os === "darwin"
            ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
            : [
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/usr/bin/chromium",
            ];
        for (const executablePath of candidates) {
            try {
                if (!(await Deno.stat(executablePath)).isFile) continue;
            } catch (error) {
                if (error instanceof Deno.errors.NotFound) continue;
                throw error;
            }
            return await chromium.launch({ executablePath, headless: true });
        }
        throw channelError;
    }
}

async function screenshot(name: string): Promise<void> {
    assert(page);
    const path = join(artifacts, `${name}.png`);
    await page.screenshot({ path, fullPage: true });
    screenshots.push(path);
}

async function assertNoOverflow(): Promise<void> {
    assert(page);
    const metrics = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>(
            "dialog[open]",
        );
        const bounds = dialog?.getBoundingClientRect();
        return {
            viewport: innerWidth,
            document: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            dialogLeft: bounds?.left ?? 0,
            dialogRight: bounds?.right ?? 0,
            dialogScroll: dialog?.scrollWidth ?? 0,
            dialogClient: dialog?.clientWidth ?? 0,
        };
    });
    assert(
        metrics.document <= metrics.viewport + 1 &&
            metrics.body <= metrics.viewport + 1 &&
            metrics.dialogLeft >= -1 &&
            metrics.dialogRight <= metrics.viewport + 1 &&
            metrics.dialogScroll <= metrics.dialogClient + 1,
        `Horizontal overflow: ${JSON.stringify(metrics)}`,
    );
}

await Deno.mkdir(artifacts);
try {
    await using resources = new AsyncDisposableStack();
    await Deno.mkdir(workspace);
    resources.defer(async () => {
        // This is the only recursive deletion: a fixed child of our own temp dir.
        assertEquals(
            relative(resolve(temporary), resolve(workspace)),
            "workspace",
        );
        await Deno.remove(workspace, { recursive: true });
    });
    await Deno.writeTextFile(
        join(workspace, "README.txt"),
        "Temporary browser fixture.\n",
    );
    const canonicalRoot = await Deno.realPath(workspace);
    const kv = await Deno.openKv(":memory:");
    resources.defer(() => kv.close());
    const builtins = await loadBuiltinComposition({
        configStore: new DenoKvConfigStore(kv),
        env: () => undefined,
        runtimeSettings: createRuntimeSettings({
            proxyKey: "",
            limitPerMinute: 0,
            probeIntervalMs: 0,
        }),
    });
    resources.defer(() => builtins.close());
    const requests = openSqliteRequestStore(":memory:");
    resources.defer(() => requests.close());
    const chat = openSqliteChatStore(":memory:");
    resources.defer(() => chat.close());
    const app = createServer({
        requestJournal: requests,
        lifecycle: createRequestLifecycle(requests),
        protocols: builtins.protocols,
        middleware: builtins.middleware,
        sourceMiddleware: builtins.sourceMiddleware,
        sourceRegistry: builtins.sources,
        adminCatalog: builtins.catalog,
        adminManagement: builtins.management,
        adminAssetsRoot: fileURLToPath(
            new URL("../public/assets/", import.meta.url),
        ),
        chat: { store: chat, tools: builtins.toolPlugins },
    });
    const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        (request) => app.fetch(request),
    );
    resources.defer(() => server.shutdown());
    const origin = `http://127.0.0.1:${server.addr.port}`;
    const readConfig = async (): Promise<ToolConfigDto> => {
        const response = await fetch(
            `${origin}${endpoint}?pluginId=${pluginId}`,
        );
        assertEquals(response.status, 200, await response.clone().text());
        const dto: ToolConfigDto = await response.json();
        assertEquals(dto.pluginId, pluginId);
        assert(dto.configSchema);
        return dto;
    };
    const initial = await readConfig();
    assertEquals(initial.config.root ?? "", "");
    assertEquals(initial.revision, null);

    const browser = await launchChrome();
    resources.defer(() => browser.close());
    browserVersion = browser.version();
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: "light",
        reducedMotion: "reduce",
    });
    context.setDefaultTimeout(10_000);
    page = await context.newPage();
    resources.defer(async () => {
        if (success || !page || page.isClosed()) return;
        try {
            await screenshot("failure");
            await Deno.writeTextFile(
                join(artifacts, "failure-page.txt"),
                await page.locator("body").innerText(),
            );
        } catch (error) {
            failures.push(`Unable to capture failure page: ${String(error)}`);
        }
    });
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
        if (message.type() !== "error") return;
        const url = message.location().url;
        const text = message.text();
        consoleErrors.push({
            text,
            url,
            expected: expectedValidationError &&
                (url.includes(endpoint) || url.includes(bridgeEndpoint)) &&
                /^Failed to load resource:.*\b(?:400|422)\b/.test(text),
        });
    });
    await page.goto(`${origin}/admin?view=overview#plugins`);
    const configure = page.getByRole("button", {
        name: configureLabel,
        exact: true,
    });
    const dialog = page.getByRole("dialog", {
        name: configureLabel,
        exact: true,
    });
    const rootInput = dialog.getByLabel("工作区路径", { exact: true });
    const readOnly = dialog.getByRole("switch", {
        name: "只读模式",
        exact: true,
    });
    const openConfig = async (): Promise<void> => {
        await configure.click();
        await rootInput.waitFor();
    };
    const saveConfig = async (): Promise<void> => {
        assert(page);
        const [response] = await Promise.all([
            page.waitForResponse(isConfigWrite),
            dialog.getByRole("button", { name: "保存配置", exact: true })
                .click(),
        ]);
        assertEquals(response.status(), 200, await response.text());
        await dialog.waitFor({ state: "hidden" });
    };
    await openConfig();
    await rootInput.fill(`${workspace}/.`);
    await assertNoOverflow();
    await screenshot("workspace-config-wide");
    await saveConfig();
    const configured = await readConfig();
    assertEquals(configured.config.root, canonicalRoot);
    assertEquals(configured.config.readOnly, false);
    assert(configured.revision !== null);
    checks.push("UI saves and normalizes the workspace root into isolated KV");

    await page.reload();
    await openConfig();
    assertEquals(await rootInput.inputValue(), canonicalRoot);
    assertEquals(await readOnly.getAttribute("aria-checked"), "false");
    await readOnly.click();
    await saveConfig();
    const readonlyConfig = await readConfig();
    assertEquals(readonlyConfig.config, {
        root: canonicalRoot,
        readOnly: true,
    });
    assert(readonlyConfig.revision !== configured.revision);
    checks.push("Reopened settings persist read-only mode with a new revision");

    await openConfig();
    assertEquals(await readOnly.getAttribute("aria-checked"), "true");
    const invalidRoot = join(workspace, "directory-that-does-not-exist");
    await rootInput.fill(invalidRoot);
    expectedValidationError = true;
    const [invalidResponse] = await Promise.all([
        page.waitForResponse(isConfigWrite),
        dialog.getByRole("button", { name: "保存配置", exact: true }).click(),
    ]);
    assert(
        [400, 422].includes(invalidResponse.status()),
        await invalidResponse.text(),
    );
    const alert = dialog.getByRole("alert");
    await alert.waitFor();
    assert((await alert.innerText()).includes("保存配置失败"));
    assertEquals(await rootInput.inputValue(), invalidRoot);
    assertEquals(await readConfig(), readonlyConfig);
    checks.push(
        "Invalid root keeps the edit visible and preserves stored settings/revision",
    );
    await screenshot("workspace-config-validation");

    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoOverflow();
    await screenshot("workspace-config-mobile");
    checks.push("1440px and 390px dialogs fit without horizontal overflow");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    assert(
        await configure.evaluate((button) => document.activeElement === button),
    );
    await openConfig();
    assertEquals(await rootInput.inputValue(), canonicalRoot);
    assertEquals(await readOnly.getAttribute("aria-checked"), "true");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert(
        await configure.evaluate((button) => document.activeElement === button),
    );
    checks.push(
        "Escape/cancel close the dialog, restore focus and discard invalid edits",
    );
    expectedValidationError = false;
    assertEquals(
        consoleErrors.filter((entry) => !entry.expected),
        [],
        "Unexpected console errors",
    );
    assertEquals(failures, [], "Browser page errors");
    success = true;
} catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    // The resource stack captures the failure page before shutting Chrome down.
    throw error;
} finally {
    const result = {
        success,
        browserVersion,
        checks,
        failures,
        consoleErrors,
        screenshots,
        artifacts,
    };
    await Deno.writeTextFile(
        join(artifacts, "result.json"),
        JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
}

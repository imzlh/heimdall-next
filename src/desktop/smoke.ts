import type { DesktopWindow } from "./native.ts";
import { unwrapDesktopResult } from "./native.ts";

/** Exercise compiled assets and dynamic plugin discovery through the real server. */
export async function verifyDesktopRuntime(
    origin: string,
    adminToken: string,
    bootstrapToken: string,
): Promise<void> {
    const request = (path: string, init: RequestInit = {}) =>
        fetch(`${origin}${path}`, {
            ...init,
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
        });
    const health = await request("/health");
    const healthBody = await health.json();
    if (!health.ok || healthBody.status !== "ok") {
        throw new Error("Desktop health check failed.");
    }
    const unauthorized = await request("/admin/plugins");
    await unauthorized.body?.cancel();
    if (unauthorized.status !== 401) {
        throw new Error("Desktop management API must require authentication.");
    }
    const plugins = await request("/admin/plugins", {
        headers: { authorization: `Bearer ${adminToken}` },
    });
    const pluginBody = await plugins.json();
    const serialized = JSON.stringify(pluginBody);
    if (
        !plugins.ok || !serialized.includes("heimdall.tool.workspace") ||
        !serialized.includes("heimdall.source.openai-compatible")
    ) {
        throw new Error(
            "Desktop built-in plugins were not loaded from the packaged resources.",
        );
    }
    const exchange = await request("/admin/desktop/bootstrap", {
        method: "POST",
        headers: {
            origin,
            "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: bootstrapToken }),
    });
    const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
    await exchange.body?.cancel();
    if (exchange.status !== 204 || !cookie) {
        throw new Error("Desktop session bootstrap failed.");
    }
    const chat = await request("/admin/chat", { headers: { cookie } });
    const html = await chat.text();
    if (
        !chat.ok || !html.includes('data-desktop="true"') ||
        !html.includes("/admin/assets/")
    ) {
        throw new Error(
            "Desktop chat workspace or packaged UI assets are missing.",
        );
    }
    const sources = [
        ...html.matchAll(
            /(?:src|href)="(\/admin\/assets\/[^"?#]+)(?:[^" ]*)"/g,
        ),
    ].map((match) => match[1]!);
    if (sources.length < 2) {
        throw new Error(
            "Desktop page did not include its local CSS and JavaScript.",
        );
    }
    for (const path of new Set(sources)) {
        const response = await request(path, { headers: { cookie } });
        const bytes = await response.arrayBuffer();
        if (!response.ok || bytes.byteLength === 0) {
            throw new Error(`Packaged desktop asset unavailable: ${path}`);
        }
    }
    console.log(
        "[desktop] Smoke passed: loopback runtime, authentication, built-in plugins, chat and bundled assets.",
    );
}

/** Click the actual page controls and wait for their native/renderer round trip. */
export async function verifyDesktopWindow(
    window: DesktopWindow,
    physicalCoordinates = Deno.build.os === "windows",
    trayEnabled = true,
): Promise<void> {
    const inspect = async (script: string) =>
        unwrapDesktopResult(await window.executeJs(script));
    const wait = async (script: string, message: string) => {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (await inspect(script) === true) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(message);
    };
    const nativeWait = async (predicate: () => boolean, message: string) => {
        for (let attempt = 0; attempt < 100; attempt++) {
            if (predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(message);
    };
    await wait(
        `!!document.querySelector('[data-desktop-titlebar]') && typeof globalThis.heimdallDesktop === 'function' && document.querySelector('[data-desktop-command="toggle-expand"]')?.disabled === false && document.querySelector('[data-desktop-titlebar]')?.hasAttribute('data-expanded')`,
        "Native desktop titlebar bridge did not connect.",
    );
    const original = window.getSize();
    await inspect(
        `document.querySelector('[data-desktop-command="toggle-expand"]').click(); true`,
    );
    await wait(
        `document.querySelector('[data-desktop-titlebar]')?.getAttribute('data-expanded') === 'true'`,
        "Desktop expand control did not reach the native window.",
    );
    const display = await inspect(
        `({width:screen.availWidth, height:screen.availHeight, scale:devicePixelRatio})`,
    ) as { width: number; height: number; scale: number };
    const scale = physicalCoordinates ? display.scale : 1;
    await nativeWait(() => {
        const [width, height] = window.getSize();
        return width === Math.round(display.width * scale) &&
            height === Math.round(display.height * scale);
    }, "Native expanded bounds do not match the display work area.");
    await inspect(
        `document.querySelector('[data-desktop-command="toggle-expand"]').click(); true`,
    );
    await wait(
        `document.querySelector('[data-desktop-titlebar]')?.getAttribute('data-expanded') === 'false'`,
        "Desktop restore control did not complete.",
    );
    for (let attempt = 0; attempt < 100; attempt++) {
        const size = window.getSize();
        if (size[0] === original[0] && size[1] === original[1]) break;
        if (attempt === 99) {
            throw new Error(
                "Native restore did not recover the original window bounds.",
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await inspect(
        `globalThis.__heimdallSmokePin = 'pending'; globalThis.heimdallDesktop('toggle-always-on-top').then(state => {globalThis.__heimdallSmokePin = state.alwaysOnTop === true ? 'passed' : 'failed';}, () => {globalThis.__heimdallSmokePin = 'failed';}); true`,
    );
    await wait(
        `globalThis.__heimdallSmokePin === 'passed'`,
        "Native always-on-top binding failed.",
    );
    await nativeWait(
        () => window.isAlwaysOnTop(),
        "Native window did not become always on top.",
    );
    await inspect(
        `globalThis.__heimdallSmokePin = 'pending'; globalThis.heimdallDesktop('toggle-always-on-top').then(state => {globalThis.__heimdallSmokePin = state.alwaysOnTop === false ? 'passed' : 'failed';}, () => {globalThis.__heimdallSmokePin = 'failed';}); true`,
    );
    await wait(
        `globalThis.__heimdallSmokePin === 'passed'`,
        "Native always-on-top restore failed.",
    );
    await nativeWait(
        () => !window.isAlwaysOnTop(),
        "Native window stayed always on top.",
    );
    const position = window.getPosition();
    for (const direction of [1, -1]) {
        await inspect(
            `globalThis.__heimdallSmokeDrag = false; (async () => {await globalThis.heimdallDesktop('drag-start', {scale:1}); await globalThis.heimdallDesktop('drag-move', {x:${
                20 * direction
            }, y:${
                10 * direction
            }}); await globalThis.heimdallDesktop('drag-end'); globalThis.__heimdallSmokeDrag = true;})(); true`,
        );
        await wait(
            `globalThis.__heimdallSmokeDrag === true`,
            "Native drag binding did not complete.",
        );
        await nativeWait(() => {
            const point = window.getPosition();
            return point[0] === position[0] + (direction === 1 ? 20 : 0) &&
                point[1] === position[1] + (direction === 1 ? 10 : 0);
        }, "Native drag did not move the window to the requested position.");
    }
    const normalSize = window.getSize();
    for (const direction of [1, -1]) {
        await inspect(
            `globalThis.__heimdallSmokeResize = false; (async () => {await globalThis.heimdallDesktop('resize-start', {edge:'se',scale:1}); await globalThis.heimdallDesktop('resize-move', {x:${
                20 * direction
            },y:${
                10 * direction
            }}); await globalThis.heimdallDesktop('resize-end'); globalThis.__heimdallSmokeResize = true;})(); true`,
        );
        await wait(
            `globalThis.__heimdallSmokeResize === true`,
            "Native edge resize did not complete.",
        );
        await nativeWait(() => {
            const size = window.getSize();
            return size[0] === normalSize[0] + (direction === 1 ? 20 : 0) &&
                size[1] === normalSize[1] + (direction === 1 ? 10 : 0);
        }, "Native edge resize did not apply the requested bounds.");
    }
    if (!trayEnabled) return;
    await inspect(
        `document.querySelector('[data-desktop-command="hide"]').click(); true`,
    );
    for (let attempt = 0; attempt < 100; attempt++) {
        if (!window.isVisible()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Desktop titlebar hide did not reach the native window.");
}

import {
    assert,
    assertEquals,
    assertStringIncludes,
    assertThrows,
} from "@std/assert";
import "hono/jsx/dom/jsx-runtime";
import {
    parseManifestUi,
    resolveUiRender,
    type UiContext,
} from "@heimdall/admin-contracts/ui.ts";
import { mount } from "../../plugins/chathub-source/ui.tsx";
import { chatHubAccountSnapshot } from "../../plugins/chathub-source/account.ts";
import manifest from "../../plugins/chathub-source/manifest.json" with {
    type: "json",
};
import { PluginSlots } from "../../src/web/components/slots.tsx";
import { sourceUiContext } from "../../src/web/shared/ui-context.ts";
import { withBuiltinPresetPages } from "../../src/composition/preset-pages.ts";
import { installTestDom } from "./helpers/jsx-dom.ts";

const snapshot = chatHubAccountSnapshot("operator@example.test", {
    meters: [
        { name: "LLMOnly", remaining: 71 },
        { name: "ImageGeneration", remaining: 0, blocked: true },
        {
            name: "access",
            blocked: true,
            error: "ImageGenInsufficientTokensThrottled",
        },
    ],
}, "2026-09-29T08:00:00.000Z");

function context(): UiContext {
    return sourceUiContext({ locale: "zh", theme: "system", data: {} }, {
        id: "account-a",
        sourcePluginId: manifest.id,
        enabled: true,
        ui: { ...snapshot, runtime: { warmContexts: 7, busyContexts: 2 } },
    });
}

Deno.test("ChatHub account slot renders its live summary without JavaScript", () => {
    const contributions = parseManifestUi(manifest);
    const account = contributions.find((entry) =>
        entry.id === "account-information"
    )!;
    assertEquals(resolveUiRender(account, withBuiltinPresetPages({})), {
        kind: "trusted",
        modulePath: "/admin/assets/plugins/chathub-account.js",
    });
    const html = PluginSlots({
        slot: "source.status",
        contributions,
        context: context(),
    })!.toString();
    assertStringIncludes(html, "ChatHub 账号信息");
    assertStringIncludes(html, "operator@example.test");
    assertStringIncludes(html, "消息额度：71");
    assertStringIncludes(html, "图片额度：0（不可用）");
    assertStringIncludes(html, "上游限制了部分能力");
    assertStringIncludes(html, "额度更新：2026-09-29 08:00:00 UTC");
    assertStringIncludes(html, "可复用上下文");
    assertStringIncludes(html, "复用中");
    assertStringIncludes(html, "<strong>7</strong>");
    assertStringIncludes(html, "<strong>2</strong>");
});

Deno.test("ChatHub account TSX shows capability balances and denial then unmounts", async () => {
    const dom = installTestDom();
    let dispose: (() => void) | undefined;
    try {
        dispose = mount(dom.root as unknown as HTMLElement, context());
        await dom.act();
        assertStringIncludes(dom.root.textContent, "operator@example.test");
        assertStringIncludes(dom.root.textContent, "消息额度71");
        assertStringIncludes(dom.root.textContent, "图片额度0当前不可用");
        assertStringIncludes(
            dom.root.textContent,
            "ImageGenInsufficientTokensThrottled",
        );
        assertEquals(
            dom.root.querySelector("time")?.getAttribute("dateTime"),
            "2026-09-29T08:00:00.000Z",
        );
        dispose();
        await dom.act();
        assertEquals(dom.root.textContent, "");
        dispose();
    } finally {
        dispose?.();
        dom.restore();
    }
});

Deno.test("ChatHub account UI scopes state to its own source and handles missing snapshots", async () => {
    const dom = installTestDom();
    let dispose: (() => void) | undefined;
    try {
        assertThrows(() =>
            mount(dom.root as unknown as HTMLElement, {
                ...context(),
                sourcePluginId: "other.source",
            }), TypeError);
        dispose = mount(dom.root as unknown as HTMLElement, {
            ...context(),
            data: {},
        });
        await dom.act();
        assertStringIncludes(dom.root.textContent, "尚无额度快照");
        assert(!dom.root.textContent.includes("operator@example.test"));
    } finally {
        dispose?.();
        dom.restore();
    }
});

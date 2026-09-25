/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { render } from "hono/jsx/dom";
import "hono/jsx/dom/jsx-runtime";
import type { UiContribution } from "@heimdall/admin-contracts/ui.ts";
import { ClientSlots } from "@heimdall/core/web/client/extensions/slots.tsx";
import { sourceUiContext } from "@heimdall/core/web/shared/ui-context.ts";
import { installTestDom } from "./helpers/jsx-dom.ts";

Deno.test("DOM slots refresh dynamic scalars and unmount disabled contributions", async () => {
    const dom = installTestDom();
    const contributions: UiContribution[] = [{
        pluginId: "sample",
        id: "models",
        slot: "source.status",
        sourcePluginId: "sample",
        title: "模型统计",
        schema: {
            blocks: [
                {
                    kind: "metric",
                    label: "模型",
                    value: "—",
                    valueFrom: ["source", "modelCount"],
                },
                {
                    kind: "badge",
                    label: "未知",
                    labelFrom: ["source", "state"],
                },
            ],
        },
    }];
    const context = { locale: "zh", theme: "system", data: {} } as const;
    const source = {
        id: "one",
        sourcePluginId: "sample",
        enabled: true,
        models: ["a"],
    };
    const draw = (
        entries: UiContribution[],
        models: string[],
        enabled: boolean,
    ) => render(
        <ClientSlots
            slot="source.status"
            contributions={entries}
            context={sourceUiContext(context, { ...source, models, enabled })}
        />,
        dom.root as unknown as HTMLElement,
    );
    try {
        await dom.act(() => draw(contributions, ["a"], true));
        assertStringIncludes(dom.root.textContent, "模型1");
        assertStringIncludes(dom.root.textContent, "已启用");
        await dom.act(() => draw(contributions, ["a", "b", "c"], false));
        assertStringIncludes(dom.root.textContent, "模型3");
        assertStringIncludes(dom.root.textContent, "已停用");
        await dom.act(() => draw([], [], false));
        assertEquals(dom.root.textContent, "");
    } finally {
        await dom.act(() => render(null, dom.root as unknown as HTMLElement));
        dom.restore();
    }
});

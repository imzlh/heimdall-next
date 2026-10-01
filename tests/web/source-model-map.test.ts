import { assertEquals, assertThrows } from "@std/assert";
import "hono/jsx/dom/jsx-runtime";
import {
    readSourceModelMapRows,
    sameSourceModelMap,
    sourceModelMapRows,
} from "../../src/web/client/forms/source-model-map.tsx";
import { createSourceSetupDraft } from "../../src/web/client/source-setup-draft.ts";

Deno.test("model mapping rows reject duplicate aliases before object conversion and reject incomplete rows", () => {
    const rows = sourceModelMapRows({
        fast: "provider-fast",
        slow: "provider-slow",
    });
    assertEquals(readSourceModelMapRows(rows), {
        fast: "provider-fast",
        slow: "provider-slow",
    });
    assertThrows(
        () =>
            readSourceModelMapRows([...rows, {
                id: 2,
                alias: " fast ",
                upstream: "different",
            }]),
        TypeError,
        "重复",
    );
    for (
        const row of [
            { id: 0, alias: "", upstream: "" },
            { id: 0, alias: "fast", upstream: "" },
            { id: 0, alias: "bad name", upstream: "upstream" },
            { id: 0, alias: "fast", upstream: "bad\nname" },
            { id: 0, alias: "__proto__", upstream: "upstream" },
            { id: 0, alias: "constructor", upstream: "upstream" },
        ]
    ) assertThrows(() => readSourceModelMapRows([row]), TypeError);
    assertEquals(
        readSourceModelMapRows([{
            id: 0,
            alias: " fast ",
            upstream: " upstream ",
        }]),
        { fast: "upstream" },
    );
    assertEquals(readSourceModelMapRows([]), {});
});

Deno.test("source mapping is detached basic metadata and survives preset and custom reselection", () => {
    const modelMap = { fast: "provider-fast" };
    const draft = createSourceSetupDraft({
        name: "渠道",
        priority: 5,
        mode: "custom",
        modelMap,
        proxy: { mode: "direct" },
    });
    modelMap.fast = "changed";
    assertEquals(draft.modelMap, { fast: "provider-fast" });
    const preset = createSourceSetupDraft({
        ...draft,
        mode: "preset",
        presetId: "heimdall.preset.newapi",
    }, draft.id);
    assertEquals(preset.modelMap, draft.modelMap);
    assertEquals(preset.id, draft.id);
    assertEquals(preset.proxy, { mode: "direct" });
    assertEquals(
        sameSourceModelMap({ a: "one", b: "two" }, { b: "two", a: "one" }),
        true,
    );
    assertEquals(sameSourceModelMap({ a: "one" }, { a: "two" }), false);
    assertEquals(sameSourceModelMap(undefined, {}), true);
});

import { raw } from "hono/html";
import { parseSourceConfigSchema } from "@heimdall/admin-contracts/form-schema.ts";
import { parseUiContributions } from "@heimdall/admin-contracts/ui.ts";
import { AdminShell } from "../src/web/components/shell.tsx";
import { ControlCatalogue, DesignFlow } from "./ui-preview-forms.tsx";
import {
    type ConsolePage,
    ConsolePageView,
} from "../src/web/pages/console.tsx";
import {
    catalogueSchema,
    contributions,
    detailsSchema,
    snapshot,
} from "./ui-preview-data.ts";

// Console and host fields reuse SSR; modal snapshots are labeled offline illustrations.
const galleryCss = `
.preview-banner, .preview-section, .preview-meta { max-width: 1320px; margin-inline: auto; }
.preview-banner { padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--accent-soft); margin-bottom: 30px; }
.preview-banner h1 { font-size: 22px; margin-bottom: 8px; }
.preview-banner p + p { margin-top: 6px; }
.preview-banner .config-actions { margin-top: 16px; }
.preview-page, .preview-section { scroll-margin-top: 24px; padding-top: 22px; margin-bottom: 52px; }
.preview-page + .preview-page, .preview-section { border-top: 1px solid var(--border); }
.preview-section { display: flex; flex-direction: column; gap: 22px; }
.preview-readonly { min-width: 0; border: 0; margin: 0; padding: 0; }
.preview-page .ssr-notice, .preview-page .page-heading form, .preview-page noscript { display: none; }
.preview-modal-stage { min-width: 0; padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-muted); scroll-margin-top: 24px; }
.preview-stage-label { margin-bottom: 22px; color: var(--muted); font-size: 12px; text-align: center; }
.preview-dialog { max-width: 100%; max-height: none; margin: 0 auto; }
.preview-created-toast { position: static; margin: 0 auto; }
.preview-meta { font-size: 12px; color: var(--muted); padding: 16px 0 26px; }
.preview-schema-key { margin-top: 14px; font-size: 12px; }
@media (prefers-reduced-motion: no-preference) {
    .preview-modal-stage:target .preview-dialog { animation: source-dialog-in var(--motion-enter) var(--motion-ease); }
    .preview-modal-stage:target .source-flow-content { animation: source-flow-in 180ms var(--motion-ease); }
}
@media (max-width: 600px) {
    .preview-modal-stage { padding: 18px 10px; }
    .preview-stage-label { margin-bottom: 16px; }
}
`;

const pages: readonly ConsolePage[] = [
    "overview",
    "channels",
    "settings",
    "plugin",
];
const navigation = [
    { id: "overview", label: "总览", href: "#overview" },
    { id: "channels", label: "渠道", href: "#channels" },
    { id: "settings", label: "设置", href: "#settings" },
    {
        id: "heimdall.preset.newapi:guide",
        label: "NewAPI 工作区",
        href: "#plugin",
    },
];

function PreviewDocument(
    { theme, css }: { theme: "light" | "dark"; css: string },
) {
    return (
        <AdminShell
            title={`Heimdall · ${theme === "light" ? "浅色" : "深色"}设计预览`}
            theme={theme}
            stylesheet=""
            brandHref="#preview-top"
            nav={navigation}
            active=""
            head={
                <>
                    <meta
                        http-equiv="Content-Security-Policy"
                        content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"
                    />
                    <style>{raw(css)}</style>
                </>
            }
        >
            <aside
                id="preview-top"
                class="preview-banner"
                aria-labelledby="preview-title"
            >
                <h1 id="preview-title">
                    Heimdall 运维控制台 · 设计预览
                </h1>
                <p>
                    示例数据 · {theme === "light" ? "浅色主题" : "深色主题"}
                    {" "}
                    · 可离线阅读
                </p>
                <p>
                    总览、渠道、设置和插件页按顺序展开，左侧导航可跳转。所有表单与动作已禁用。
                </p>
                <p>
                    管理页面与自定义表单复用实际服务端组件；添加渠道展示同一模态的步骤快照，包含
                    NewAPI 配置与 ChatHub 授权的静态示意。
                </p>
                <div class="config-actions">
                    <a class="text-button" href="#flow">添加渠道流程</a>
                    <a class="text-button" href="#controls">表单控件目录</a>
                </div>
            </aside>
            {pages.map((page) => (
                <section
                    id={page}
                    class="preview-page"
                    aria-label={`${
                        navigation.find((item) => item.href === `#${page}`)
                            ?.label
                    }页面预览`}
                >
                    <fieldset
                        disabled
                        class="preview-readonly"
                        aria-label="只读页面预览"
                    >
                        <ConsolePageView
                            snapshot={snapshot}
                            page={page}
                            tab="heimdall.preset.newapi:guide"
                            contributions={contributions}
                        />
                    </fieldset>
                </section>
            ))}
            <DesignFlow />
            <ControlCatalogue />
            <footer class="preview-meta">
                由实际 Hono JSX 组件与手写样式生成。未加载浏览器
                island；此文件不代表真实浏览器交互验收。
            </footer>
        </AdminShell>
    );
}

parseUiContributions(contributions);
for (const schema of [detailsSchema, catalogueSchema]) {
    parseSourceConfigSchema(schema);
}
const root = new URL("../", import.meta.url);
const css = (await Promise.all(
    ["style.css", "shell.css", "cards.css", "preset-auth.css"].map((name) =>
        Deno.readTextFile(new URL(`src/web/client/${name}`, root))
    ),
)).join("\n") + galleryCss;
if (/@import\b|url\s*\(/i.test(css)) {
    throw new Error("Preview CSS must be self-contained");
}
const output = new URL("docs/previews/", root);
await Deno.mkdir(output, { recursive: true });
for (const theme of ["light", "dark"] as const) {
    const rendered = (<PreviewDocument theme={theme} css={css} />).toString();
    const html = "<!doctype html>\n" + rendered.replace(
        /href="(\/admin(?:\?[^"]*)?)"/g,
        (_, href: string) => {
            const url = new URL(
                href.replaceAll("&amp;", "&"),
                "https://preview.invalid",
            );
            const page = url.searchParams.get("view") ?? "overview";
            if (!pages.includes(page as ConsolePage)) {
                throw new Error(`Unknown preview page: ${page}`);
            }
            return `href="#${page}"`;
        },
    );
    if (/<script\b|<link\b|\bsrc=/i.test(html)) {
        throw new Error("Preview must not load external resources");
    }
    const ids = new Set(
        [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]),
    );
    for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
        if (!href?.startsWith("#") || !ids.has(href.slice(1))) {
            throw new Error(`Invalid preview link: ${href}`);
        }
    }
    await Deno.writeTextFile(new URL(`operator-${theme}.html`, output), html);
    console.log(`Generated docs/previews/operator-${theme}.html`);
}

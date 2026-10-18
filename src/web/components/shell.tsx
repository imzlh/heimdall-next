/**
 * SSR shell for the operator console. hono/jsx renders this to HTML on the Deno
 * server; interactive regions mount client-side as islands. This module has
 * no client-only APIs so it renders identically on the server and in a test.
 */
import type { Child, FC } from "hono/jsx";
import { Icon, type IconName } from "../shared/icons.tsx";
import { HEIMDALL_ICON_URL } from "../shared/brand.ts";
import { DesktopTitlebar } from "./desktop-titlebar.tsx";

export interface NavItem {
    readonly id: string;
    readonly label: string;
    readonly href: string;
}

export interface AdminShellProps {
    readonly title: string;
    readonly nav: readonly NavItem[];
    readonly active: string;
    readonly children?: Child;
    readonly scripts?: Child;
    readonly theme?: "light" | "dark";
    readonly stylesheet?: string;
    readonly head?: Child;
    readonly brandHref?: string;
    readonly desktop?: boolean;
}

function NavGlyph({ id }: { id: string }) {
    const names: Record<string, IconName> = {
        overview: "overview",
        channels: "channels",
        logs: "logs",
        settings: "settings",
        chat: "chat",
    };
    return <Icon name={names[id] ?? "plugin"} class="nav-icon" />;
}

function NavigationLink({ item, active }: { item: NavItem; active: string }) {
    return (
        <a
            href={item.href}
            class={`admin-nav-link${item.id === active ? " active" : ""}`}
            aria-current={item.id === active ? "page" : undefined}
            title={item.label}
            data-plugin-nav={item.id.includes(":") ? "" : undefined}
        >
            <NavGlyph id={item.id} />
            <span class="nav-label">{item.label}</span>
        </a>
    );
}

export const AdminShell: FC<AdminShellProps> = (props) => (
    <html
        lang="zh"
        data-theme={props.theme}
        data-desktop={props.desktop ? "true" : undefined}
    >
        <head>
            <meta charset="utf-8" />
            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            />
            <title>{props.title}</title>
            <meta name="color-scheme" content="light dark" />
            <link rel="icon" type="image/svg+xml" href={HEIMDALL_ICON_URL} />
            {props.stylesheet !== "" && (
                <link
                    rel="stylesheet"
                    href={props.stylesheet ?? "/admin/assets/console.css"}
                />
            )}
            {props.head}
        </head>
        <body class="admin-shell">
            <a class="skip-link" href="#admin-main">跳到主要内容</a>
            {props.desktop && <DesktopTitlebar workspace="工作空间" />}
            <aside class="admin-sidebar" aria-label="工作空间">
                <header class="admin-header">
                    <a
                        class="admin-brand"
                        href={props.brandHref ?? "/admin"}
                        aria-label="Heimdall 总览"
                    >
                        <span class="brand-mark" aria-hidden="true">H</span>
                        <span>
                            Heimdall<small>统一模型网关</small>
                        </span>
                    </a>
                </header>
                <nav
                    class="admin-nav"
                    aria-label="主导航"
                    data-admin-navigation=""
                >
                    <span class="host-badge">工作空间</span>
                    {props.nav.filter((item) => !item.id.includes(":")).map((
                        item,
                    ) => (
                        <NavigationLink
                            key={item.id}
                            item={item}
                            active={props.active}
                        />
                    ))}
                    <div
                        class="plugin-navigation"
                        data-plugin-navigation=""
                        hidden={!props.nav.some((item) =>
                            item.id.includes(":")
                        )}
                    >
                        {props.nav.filter((item) => item.id.includes(":")).map((
                            item,
                        ) => (
                            <NavigationLink
                                key={item.id}
                                item={item}
                                active={props.active}
                            />
                        ))}
                    </div>
                </nav>
                <footer class="sidebar-footer">
                    <span class="sidebar-monogram" aria-hidden="true">H</span>
                    <div>
                        <strong>Heimdall</strong>
                        <small>
                            {props.desktop ? "桌面工作区" : "运维控制台"}
                        </small>
                    </div>
                    <span class="sidebar-version">
                        {props.desktop ? "DESKTOP" : "NEXT"}
                    </span>
                </footer>
            </aside>
            <main class="admin-main" id="admin-main" tabindex={-1}>
                {props.children}
            </main>
            {props.scripts}
        </body>
    </html>
);

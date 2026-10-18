import type { Child, FC } from "hono/jsx";
import { HEIMDALL_ICON_URL } from "../shared/brand.ts";
import { DesktopTitlebar } from "./desktop-titlebar.tsx";

export interface ChatShellProps {
    readonly children?: Child;
    readonly scripts?: Child;
    readonly theme?: "light" | "dark";
    readonly stylesheet?: string;
    readonly head?: Child;
    readonly desktop?: boolean;
}

/** A small SSR document shared by the chat route and its offline preview. */
export const ChatShell: FC<ChatShellProps> = (props) => (
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
            <title>Heimdall Chat</title>
            <meta name="color-scheme" content="light dark" />
            <link rel="icon" type="image/svg+xml" href={HEIMDALL_ICON_URL} />
            {props.stylesheet !== "" && (
                <link
                    rel="stylesheet"
                    href={props.stylesheet ?? "/admin/assets/chat.css"}
                />
            )}
            {props.head}
        </head>
        <body class="chat-body">
            <a class="skip-link" href="#chat-main">跳到对话</a>
            {props.desktop && <DesktopTitlebar workspace="对话" />}
            {props.children}
            {props.scripts}
        </body>
    </html>
);

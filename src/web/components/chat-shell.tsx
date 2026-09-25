import type { Child, FC } from "hono/jsx";

export interface ChatShellProps {
    readonly children?: Child;
    readonly scripts?: Child;
    readonly theme?: "light" | "dark";
    readonly stylesheet?: string;
    readonly head?: Child;
}

/** A small SSR document shared by the chat route and its offline preview. */
export const ChatShell: FC<ChatShellProps> = (props) => (
    <html lang="zh" data-theme={props.theme}>
        <head>
            <meta charset="utf-8" />
            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            />
            <title>Heimdall Chat</title>
            <meta name="color-scheme" content="light dark" />
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
            {props.children}
            {props.scripts}
        </body>
    </html>
);

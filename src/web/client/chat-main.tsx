/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { render } from "hono/jsx/dom";
import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";
import { ChatApp } from "./chat-app.tsx";
import "./style.css";
import "./chat/messages.css";
import "./chat/composer.css";
import "./chat.css";

const root = document.getElementById("heimdall-chat");
const boot = document.getElementById("heimdall-chat-boot");
if (root && boot?.textContent) {
    const fallback = [...root.childNodes].map((node) => node.cloneNode(true));
    try {
        const initial = JSON.parse(boot.textContent) as ChatInitial;
        if (
            !Array.isArray(initial.conversations) ||
            !Array.isArray(initial.messages) || !Array.isArray(initial.models)
        ) throw new Error("Invalid chat snapshot");
        // Preserve the server's ordinary login form until a session is established.
        if (initial.authenticated) {
            render(<ChatApp initial={initial} />, root);
            root.dataset.enhanced = "true";
        }
    } catch {
        root.replaceChildren(...fallback);
        delete root.dataset.enhanced;
        const notice = document.createElement("p");
        notice.className = "chat-notice";
        notice.textContent = "交互组件暂不可用，当前仍可阅读会话。";
        root.prepend(notice);
    }
}

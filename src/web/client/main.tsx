/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { render } from "hono/jsx/dom";
import { Console, type ConsoleProps } from "./console.tsx";
import { clearAdminToken, configureAdminTransport } from "./api/admin.ts";
import { login, logout, sendUiAction, sessionFetch } from "./session.ts";
import { loadUiCatalog } from "./ui-catalog.ts";
import "./style.css";
import "./shell.css";
import "./cards.css";
import "./preset-auth.css";

const root = document.getElementById("heimdall-console");
const boot = document.getElementById("heimdall-boot");
if (root && boot?.textContent) {
    const snapshot = [...root.childNodes].map((node) => node.cloneNode(true));
    try {
        const props = JSON.parse(boot.textContent) as ConsoleProps;
        // Retire the old bearer-in-sessionStorage UI; the new console uses HttpOnly sessions.
        clearAdminToken();
        configureAdminTransport(sessionFetch);
        render(
            <Console
                {...props}
                onConnect={login}
                onLogout={logout}
                onAction={sendUiAction}
                loadUiCatalog={loadUiCatalog}
            />,
            root,
        );
        root.dataset.enhanced = "true";
    } catch {
        // A missing or invalid enhancement must leave the readable SSR view in place.
        root.replaceChildren(...snapshot);
        delete root.dataset.enhanced;
        const message = document.createElement("p");
        message.className = "notice";
        message.textContent = "交互组件暂不可用，当前仍可阅读服务端快照。";
        root.prepend(message);
    }
}

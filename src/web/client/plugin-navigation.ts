import {
    pluginNavItems,
    type UiContribution,
} from "@heimdall/admin-contracts/ui.ts";
import { createIconElement } from "../shared/icons.tsx";

/** Keep the small SSR navigation region in step with the console catalog. */
export function syncPluginNavigation(
    contributions: readonly UiContribution[],
    active: string,
    document: Pick<
        Document,
        "querySelector" | "createElement" | "createElementNS"
    >,
): void {
    const region = document.querySelector<HTMLElement>(
        "[data-plugin-navigation]",
    );
    if (!region) return;
    const items = pluginNavItems(contributions);
    const signature = JSON.stringify([items, active]);
    if (region.dataset.catalogSignature === signature) return;
    const links = items.map((item) => {
        const link = document.createElement("a");
        link.href = item.href;
        link.className = `admin-nav-link${item.id === active ? " active" : ""}`;
        link.setAttribute("data-plugin-nav", "");
        if (item.id === active) link.setAttribute("aria-current", "page");
        const icon = createIconElement("plugin", document, {
            class: "nav-icon",
        });
        const label = document.createElement("span");
        label.className = "nav-label";
        label.textContent = item.label;
        link.append(icon, label);
        return link;
    });
    region.replaceChildren(...links);
    region.hidden = links.length === 0;
    region.dataset.catalogSignature = signature;
}

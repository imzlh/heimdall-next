import { Icon } from "../shared/icons.tsx";

/** Only desktop documents render controls for the authenticated native bridge. */
export function DesktopTitlebar({ workspace }: { workspace: string }) {
    return (
        <header class="desktop-titlebar" data-desktop-titlebar="">
            <button
                type="button"
                class="desktop-window-button desktop-menu-button"
                data-desktop-command="menu"
                aria-label="桌面菜单"
                aria-haspopup="menu"
                title="桌面菜单"
                disabled
            >
                <Icon name="menu" size={16} />
            </button>
            <div class="desktop-drag-region" data-desktop-drag="">
                <span class="desktop-window-brand">Heimdall</span>
                <span class="desktop-workspace-name">{workspace}</span>
                <span class="desktop-pinned" data-desktop-pinned="" hidden>
                    置顶
                </span>
            </div>
            <div
                class="desktop-window-controls"
                role="group"
                aria-label="窗口控制"
            >
                <button
                    type="button"
                    class="desktop-window-button"
                    data-desktop-command="toggle-expand"
                    aria-label="展开窗口"
                    title="展开窗口"
                    disabled
                >
                    <span data-desktop-expand-icon="">
                        <Icon name="window" size={14} />
                    </span>
                    <span data-desktop-restore-icon="" hidden>
                        <Icon name="copy" size={14} />
                    </span>
                </button>
                <button
                    type="button"
                    class="desktop-window-button desktop-hide-button"
                    data-desktop-command="hide"
                    aria-label="关闭窗口"
                    title="关闭窗口"
                    disabled
                >
                    <Icon name="close" size={17} />
                </button>
            </div>
            <span class="sr-only" role="status" data-desktop-status="" />
            {["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((edge) => (
                <div
                    key={edge}
                    class={`desktop-resize-handle desktop-resize-${edge}`}
                    data-desktop-resize={edge}
                    aria-hidden="true"
                />
            ))}
        </header>
    );
}

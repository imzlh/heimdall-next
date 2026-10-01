export const PLUGIN_CATALOG_CHANGED = "heimdall:plugins-changed";
export const PLUGIN_CATALOG_STORAGE_KEY = "heimdall.plugins.revision";

/** Invalidate open Chat tabs after a successful management mutation. No package data is broadcast. */
export function notifyPluginCatalogChanged(): void {
    try {
        globalThis.localStorage?.setItem(
            PLUGIN_CATALOG_STORAGE_KEY,
            `${Date.now()}:${Math.random()}`,
        );
    } catch { /* Focus and periodic refresh also cover unavailable storage. */ }
    globalThis.dispatchEvent(new Event(PLUGIN_CATALOG_CHANGED));
}

import type { ListedPlugin } from "./console.ts";

/** One public projection for initial HTML and later browser catalog refreshes. */
export function projectListedPlugins(
    value: unknown,
    transform: (text: string) => string = (text) => text,
): ListedPlugin[] {
    if (!Array.isArray(value)) return [];
    const text = (item: unknown): string | undefined =>
        typeof item === "string" ? transform(item) : undefined;
    const strings = (items: unknown): string[] =>
        Array.isArray(items)
            ? items.filter((item): item is string => typeof item === "string")
                .map(transform)
            : [];
    const bool = (item: unknown): boolean | undefined =>
        typeof item === "boolean" ? item : undefined;
    return value.flatMap((item): ListedPlugin[] => {
        if (
            item === null || typeof item !== "object" || Array.isArray(item) ||
            typeof item.id !== "string" || !item.id.trim()
        ) return [];
        return [{
            id: transform(item.id),
            name: text(item.name),
            description: text(item.description),
            capabilities: strings(item.capabilities),
            dependencies: strings(item.dependencies),
            kind: text(item.kind),
            version: text(item.version),
            trust: text(item.trust),
            enabled: bool(item.enabled),
            lastError: text(item.lastError),
            canToggle: bool(item.canToggle),
            managed: bool(item.managed),
            revision: text(item.revision),
            rollbackVersion: text(item.rollbackVersion),
        }];
    });
}

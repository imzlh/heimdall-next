import {
    parseManifestUi,
    UI_LIMITS,
    type UiContribution,
    uiContributionKey,
} from "@heimdall/admin-contracts/ui.ts";
import {
    type PluginManifestOptions,
    readPluginManifests,
} from "./plugin-manifests.ts";
import { log } from "../observability/system-log.ts";
import type { PluginHost } from "@heimdall/plugin-host";

export { MAX_PLUGIN_MANIFEST_BYTES as MAX_UI_MANIFEST_BYTES } from "./plugin-manifests.ts";

export type UiContributionLoaderOptions = PluginManifestOptions;

/** Installed packages contribute only validated JSON from currently enabled records. */
export async function loadRuntimeUiContributions(
    host: Pick<PluginHost, "list">,
    options: UiContributionLoaderOptions = {},
): Promise<readonly UiContribution[]> {
    const [local, records] = await Promise.all([
        loadUiContributions(options),
        host.list(),
    ]);
    const contributions = [...local];
    const keys = new Set(local.map(uiContributionKey));
    const warn = options.warn ?? ((message: string) => log.warn("ui", message));
    for (
        const record of records.filter((item) => item.enabled).toSorted((
            left,
            right,
        ) => left.manifest.id.localeCompare(right.manifest.id))
    ) {
        try {
            const declared = parseManifestUi(record.manifest);
            if (
                declared.some((item) => keys.has(uiContributionKey(item))) ||
                contributions.length + declared.length > UI_LIMITS.contributions
            ) {
                throw new TypeError("duplicate or oversized UI declarations");
            }
            contributions.push(...declared);
            for (const item of declared) keys.add(uiContributionKey(item));
        } catch {
            // Invalid UI is local to this package; healthy tools and slots remain available.
            warn(
                `Ignoring installed plugin UI ${
                    JSON.stringify(record.manifest.id)
                }: invalid or conflicting declarations.`,
            );
        }
    }
    return contributions;
}

/** Discover JSON UI declarations without evaluating a plugin's runtime module. */
export async function loadUiContributions(
    options: UiContributionLoaderOptions = {},
): Promise<readonly UiContribution[]> {
    const warn = options.warn ??
        ((message: string) => log.warn("ui", message));
    const contributions: UiContribution[] = [];
    const keys = new Set<string>();
    for await (const { directory, manifest } of readPluginManifests(options)) {
        const label = JSON.stringify(directory);
        let declared: readonly UiContribution[];
        try {
            declared = parseManifestUi(manifest);
        } catch {
            warn(`Ignoring UI manifest ${label}: invalid UI declarations.`);
            continue;
        }
        if (declared.some((entry) => keys.has(uiContributionKey(entry)))) {
            warn(`Ignoring UI manifest ${label}: duplicate UI contributions.`);
            continue;
        }
        if (
            contributions.length + declared.length > UI_LIMITS.contributions
        ) {
            warn(`Ignoring UI manifest ${label}: host UI contribution limit.`);
            continue;
        }
        contributions.push(...declared);
        for (const entry of declared) keys.add(uiContributionKey(entry));
    }
    // Manifest trust is never translated into a host execution policy.
    return contributions;
}

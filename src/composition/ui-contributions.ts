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

export { MAX_PLUGIN_MANIFEST_BYTES as MAX_UI_MANIFEST_BYTES } from "./plugin-manifests.ts";

export type UiContributionLoaderOptions = PluginManifestOptions;

/** Discover JSON UI declarations without evaluating a plugin's runtime module. */
export async function loadUiContributions(
    options: UiContributionLoaderOptions = {},
): Promise<readonly UiContribution[]> {
    const warn = options.warn ?? ((message: string) => console.warn(message));
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

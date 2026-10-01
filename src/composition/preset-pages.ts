import {
    safeUiAssetPath,
    type UiPolicy,
} from "@heimdall/admin-contracts/ui.ts";
import {
    type PluginManifestOptions,
    readPluginManifests,
} from "./plugin-manifests.ts";

/** Reviewed, bundled first-party UI. Manifest trust alone never grants execution. */
export const BUILTIN_PRESET_MODULES: Readonly<Record<string, string>> = {
    "heimdall.preset.newapi:setup": "/admin/assets/plugins/newapi-setup.js",
    "heimdall.preset.chathub:setup": "/admin/assets/plugins/chathub-setup.js",
};

const BUILTIN_SLOT_MODULES: Readonly<Record<string, string>> = {
    "heimdall.source.chathub:account-information":
        "/admin/assets/plugins/chathub-account.js",
};

export function withBuiltinPresetPages(policy: UiPolicy): UiPolicy {
    return {
        ...policy,
        trustedModules: {
            ...BUILTIN_PRESET_MODULES,
            ...BUILTIN_SLOT_MODULES,
            ...policy.trustedModules,
        },
    };
}

/** Re-read only JSON metadata; plugin JavaScript is executed solely in its approved page. */
export async function loadPresetPages(
    policy: UiPolicy,
    options: PluginManifestOptions = {},
): Promise<Readonly<Record<string, string>>> {
    const pages: Record<string, string> = {};
    for await (const { manifest } of readPluginManifests(options)) {
        if (!manifest || typeof manifest !== "object") continue;
        const item = manifest as Record<string, unknown>;
        if (item.kind !== "preset" || typeof item.id !== "string") continue;
        const page = item.presetPage;
        if (!page || typeof page !== "object" || Array.isArray(page)) continue;
        const path = (page as Record<string, unknown>).modulePath;
        const key = `${item.id}:setup`;
        if (
            safeUiAssetPath(path, "js") && policy.trustedModules &&
            Object.hasOwn(policy.trustedModules, key) &&
            policy.trustedModules[key] === path
        ) {
            if (!Object.hasOwn(pages, item.id)) {
                Object.defineProperty(pages, item.id, {
                    value: path,
                    enumerable: true,
                });
            }
        }
    }
    return pages;
}

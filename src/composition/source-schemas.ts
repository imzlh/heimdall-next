import { parseSourceConfigSchema } from "@heimdall/admin-contracts/form-schema.ts";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import {
    type PluginManifestOptions,
    readPluginManifests,
} from "./plugin-manifests.ts";
import { log } from "../observability/system-log.ts";

export type SourceSchemaLoaderOptions = PluginManifestOptions;

/** Load source and preset forms from their owning plugin's JSON manifest. */
export async function loadSourceSchemas(
    options: SourceSchemaLoaderOptions = {},
): Promise<Readonly<Record<string, SourceConfigSchema>>> {
    const schemas = new Map<string, SourceConfigSchema>();
    const warn = options.warn ??
        ((message: string) => log.warn("sources", message));
    for await (const { directory, manifest } of readPluginManifests(options)) {
        if (
            manifest === null || typeof manifest !== "object" ||
            Array.isArray(manifest)
        ) continue;
        const declared = manifest as Record<string, unknown>;
        if (
            declared.configSchema === undefined ||
            (declared.kind !== "source" && declared.kind !== "preset")
        ) continue;
        const label = JSON.stringify(directory);
        let schema: SourceConfigSchema;
        try {
            schema = parseSourceConfigSchema(declared.configSchema);
            if (schema.id !== declared.id) {
                throw new TypeError("Schema must use its manifest's plugin id");
            }
        } catch {
            warn(
                `Ignoring config schema ${label}: invalid schema declaration.`,
            );
            continue;
        }
        if (schemas.has(schema.id)) {
            warn(`Ignoring config schema ${label}: duplicate plugin id.`);
            continue;
        }
        schemas.set(schema.id, schema);
    }
    return Object.fromEntries(schemas);
}

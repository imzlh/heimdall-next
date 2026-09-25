import {
    formControls,
    type FormErrors,
    type FormValue,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
    validateForm,
} from "@heimdall/admin-contracts/forms.ts";
import type { LoadedSourceConfig, SourceConfigInput } from "../api/admin.ts";

/** Select schema fields only, never putting a saved secret back into a control. */
export function sourceFormValues(
    schema: SourceConfigSchema,
    config: LoadedSourceConfig = {},
): FormValues {
    const safe: Record<string, FormValue> = {};
    for (const field of formControls(schema)) {
        if (field.type === "secret" || field.type === "authorization") continue;
        const value = (config as Record<string, unknown>)[field.name];
        if (
            typeof value === "string" || typeof value === "number" ||
            typeof value === "boolean"
        ) safe[field.name] = value;
        else if (
            field.type === "string" && field.format === "string-map" && value &&
            typeof value === "object" && !Array.isArray(value)
        ) {
            safe[field.name] = JSON.stringify(value, null, 2);
        }
    }
    return initialFormValues(schema, safe);
}

/** A preset stays bound to the loaded source, so its default id cannot redirect a write. */
export function prepareSourceInput(
    schema: SourceConfigSchema,
    values: FormValues,
    sourceId: string,
    existingSecrets: readonly string[],
    presetId = "",
): { config?: SourceConfigInput; errors: FormErrors } {
    const checked = validateForm(schema, values, { existingSecrets });
    if (!checked.valid) return { errors: checked.errors };
    const config: SourceConfigInput = { ...checked.values, id: sourceId };
    if (presetId !== "heimdall.preset.newapi") return { config, errors: {} };
    if (config.compat && config.compat !== "full") {
        return {
            errors: {
                compat:
                    "此预设使用完整兼容模式。请切换自定义配置以保留当前兼容模式。",
            },
        };
    }
    // NewAPI's quick form carries over saved raw fields; its mapper owns capability defaults.
    delete config.compat;
    return { config, errors: {} };
}

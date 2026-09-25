/** Host-owned, JSON-only form descriptions. Plugins supply data, never controls. */
export type FormValue =
    | string
    | number
    | boolean
    | null
    | readonly FormValue[]
    | FormObject;
export interface FormObject {
    readonly [key: string]: FormValue;
}
export type FormValues = Readonly<Record<string, FormValue>>;
export type FormErrors = Readonly<Record<string, string>>;

/** Action IDs are resolved by the host; no URLs, functions or executable code. */
export interface FormAction {
    readonly id: string;
    readonly params?: FormObject;
}

interface FieldBase {
    readonly name: string;
    readonly label: string;
    readonly help?: string;
    readonly required?: boolean;
    readonly readOnly?: boolean;
}

export interface StringField extends FieldBase {
    readonly type: "string";
    readonly default?: string;
    readonly placeholder?: string;
    readonly multiline?: boolean;
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly format?: "url" | "string-map";
}

export interface SecretField extends FieldBase {
    readonly type: "secret";
    readonly minLength?: number;
    readonly maxLength?: number;
    /** Blank input preserves the saved value. Clearing requires a separate host action. */
    readonly preserveOnBlank?: boolean;
}

export interface NumberField extends FieldBase {
    readonly type: "number";
    readonly default?: number;
    readonly min?: number;
    readonly max?: number;
    readonly integer?: boolean;
    readonly step?: number;
}

export interface BooleanField extends FieldBase {
    readonly type: "bool";
    readonly default?: boolean;
}

export interface EnumField extends FieldBase {
    readonly type: "enum";
    readonly default?: string;
    readonly options: readonly {
        readonly value: string;
        readonly label: string;
    }[];
}

export interface AuthorizationField extends FieldBase {
    readonly type: "authorization";
    readonly buttonLabel?: string;
    readonly action: FormAction;
}

export interface FormGroup {
    readonly type: "group";
    readonly id: string;
    readonly label: string;
    readonly help?: string;
    readonly fields: readonly FormField[];
}

export type FormControl =
    | StringField
    | SecretField
    | NumberField
    | BooleanField
    | EnumField
    | AuthorizationField;
export type FormField = FormControl | FormGroup;
export interface SourceConfigSchema {
    readonly version: 1;
    readonly id: string;
    readonly title?: string;
    readonly fields: readonly FormField[];
}

export interface AuthorizationState {
    readonly state: "idle" | "pending" | "success" | "error";
    readonly message?: string;
}
export type AuthorizationStates = Readonly<Record<string, AuthorizationState>>;

export interface FormOptions {
    readonly existingSecrets?: readonly string[];
    readonly authorization?: AuthorizationStates;
}

export function formControls(
    schema: SourceConfigSchema,
): readonly FormControl[] {
    const collect = (fields: readonly FormField[]): FormControl[] =>
        fields.flatMap((field) =>
            field.type === "group" ? collect(field.fields) : [field]
        );
    return collect(schema.fields);
}

/** Safe initial values for both SSR and islands; saved secret values never cross into controls. */
export function initialFormValues(
    schema: SourceConfigSchema,
    saved: FormValues = {},
): FormValues {
    const values: Record<string, FormValue> = {};
    for (const field of formControls(schema)) {
        if (field.type === "authorization") continue;
        if (field.type === "secret") {
            values[field.name] = "";
            continue;
        }
        const value = (Object.hasOwn(saved, field.name)
            ? saved[field.name]
            : undefined) ?? field.default;
        if (value !== undefined) {
            values[field.name] =
                field.type === "string" && field.format === "string-map" &&
                    typeof value === "object"
                    ? JSON.stringify(value, null, 2)
                    : value;
        } else values[field.name] = field.type === "bool" ? false : "";
    }
    return values;
}

/** Whitelists fields and normalizes input. Server validation remains authoritative. */
export function validateForm(
    schema: SourceConfigSchema,
    input: FormValues,
    options: FormOptions = {},
): {
    readonly valid: boolean;
    readonly values: FormValues;
    readonly errors: FormErrors;
} {
    const values: Record<string, FormValue> = {};
    const errors: Record<string, string> = {};
    for (const field of formControls(schema)) {
        if (field.type === "authorization") {
            if (
                field.required &&
                options.authorization?.[field.name]?.state !== "success"
            ) errors[field.name] = "请先完成授权";
            continue;
        }
        const raw = Object.hasOwn(input, field.name)
            ? input[field.name]
            : undefined;
        const blank = raw === undefined || raw === null ||
            (typeof raw === "string" && raw.trim() === "");
        if (blank) {
            const preserved = field.type === "secret" &&
                field.preserveOnBlank !== false &&
                options.existingSecrets?.includes(field.name);
            if (field.required && !preserved) errors[field.name] = "请填写此项";
            continue;
        }
        const checked = checkControl(field, raw);
        if (checked.error) errors[field.name] = checked.error;
        else if (checked.value !== undefined) {
            values[field.name] = checked.value;
        }
    }
    return { valid: Object.keys(errors).length === 0, values, errors };
}

function checkControl(
    field: Exclude<FormControl, AuthorizationField>,
    raw: FormValue,
): { value?: FormValue; error?: string } {
    if (field.type === "bool") {
        return typeof raw === "boolean"
            ? { value: raw }
            : { error: "请选择开关状态" };
    }
    if (field.type === "number") {
        const value = typeof raw === "string" ? Number(raw) : raw;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return { error: "请输入有效数字" };
        }
        if (field.integer && !Number.isSafeInteger(value)) {
            return { error: "请输入整数" };
        }
        if (field.min !== undefined && value < field.min) {
            return { error: `不能小于 ${field.min}` };
        }
        if (field.max !== undefined && value > field.max) {
            return { error: `不能大于 ${field.max}` };
        }
        if (field.step !== undefined && field.step > 0) {
            const steps = (value - (field.min ?? 0)) / field.step;
            const tolerance = Number.EPSILON * Math.max(1, Math.abs(steps)) * 8;
            if (Math.abs(steps - Math.round(steps)) > tolerance) {
                return { error: `请按 ${field.step} 的步长填写` };
            }
        }
        return { value };
    }
    if (typeof raw !== "string") return { error: "请输入文本" };
    if (field.type === "enum") {
        return field.options.some((option) => option.value === raw)
            ? { value: raw }
            : { error: "请选择有效选项" };
    }
    const value = field.type === "secret" ? raw : raw.trim();
    if (field.minLength !== undefined && value.length < field.minLength) {
        return { error: `至少输入 ${field.minLength} 个字符` };
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
        return { error: `最多输入 ${field.maxLength} 个字符` };
    }
    if (field.type === "string" && field.format === "url") {
        try {
            const url = new URL(value);
            if (
                !["http:", "https:"].includes(url.protocol) || url.username ||
                url.password || url.search || url.hash
            ) return { error: "请输入不含凭据、查询参数或片段的 HTTP(S) 地址" };
        } catch {
            return { error: "请输入完整的 HTTP(S) 地址" };
        }
    }
    if (field.type === "string" && field.format === "string-map") {
        try {
            const record: unknown = JSON.parse(value);
            if (
                !record || typeof record !== "object" ||
                Array.isArray(record) ||
                Object.entries(record).some(([key, item]) =>
                    !key.trim() ||
                    ["__proto__", "constructor", "prototype"].includes(key) ||
                    typeof item !== "string"
                )
            ) return { error: "请输入键和值均为文本的 JSON 对象" };
            return { value: record as FormObject };
        } catch {
            return { error: "JSON 格式不正确" };
        }
    }
    return { value };
}

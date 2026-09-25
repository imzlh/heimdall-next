import type { Child } from "hono/jsx";
import {
    type AuthorizationStates,
    type FormErrors,
    type FormField,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
} from "@heimdall/admin-contracts/forms.ts";

export interface SchemaFieldsProps {
    readonly schema: SourceConfigSchema;
    readonly values?: FormValues;
    readonly errors?: FormErrors;
    readonly existingSecrets?: readonly string[];
    readonly authorization?: AuthorizationStates;
    readonly idPrefix?: string;
    readonly disabled?: boolean;
}

/** Server fields remain readable without JavaScript; the caller owns the form. */
export function SchemaFields(props: SchemaFieldsProps) {
    const values = initialFormValues(props.schema, props.values);
    const prefix = props.idPrefix ??
        `config-${encodeURIComponent(props.schema.id)}`;

    function renderField(field: FormField): Child {
        if (field.type === "group") {
            const id = `${prefix}-group-${encodeURIComponent(field.id)}`;
            return (
                <fieldset
                    class="schema-group"
                    aria-describedby={field.help ? `${id}-help` : undefined}
                >
                    <legend>{field.label}</legend>
                    {field.help && (
                        <p class="field-help" id={`${id}-help`}>{field.help}</p>
                    )}
                    {field.fields.map(renderField)}
                </fieldset>
            );
        }
        const id = `${prefix}-${encodeURIComponent(field.name)}`;
        const error = props.errors?.[field.name];
        const preserved = field.type === "secret" &&
            field.preserveOnBlank !== false &&
            props.existingSecrets?.includes(field.name);
        const help = [
            field.help,
            preserved ? "已配置，留空保留原值。" : undefined,
        ].filter(Boolean).join(" ");
        const descriptions = [
            help ? `${id}-help` : "",
            error ? `${id}-error` : "",
            field.type === "authorization" ? `${id}-status` : "",
        ].filter(Boolean).join(" ");
        const attrs = {
            id,
            name: field.name,
            disabled: props.disabled,
            "aria-describedby": descriptions || undefined,
            "aria-invalid": error ? true : undefined,
        };
        const required = field.required && !preserved;
        const value = values[field.name];
        let control: Child;
        switch (field.type) {
            case "string": {
                const text = typeof value === "string" ? value : "";
                const textAttrs = {
                    ...attrs,
                    required,
                    readOnly: field.readOnly,
                    placeholder: field.placeholder,
                    minLength: field.minLength,
                    maxLength: field.maxLength,
                };
                control = field.multiline || field.format === "string-map"
                    ? <textarea {...textAttrs} rows={4}>{text}</textarea>
                    : (
                        <input
                            {...textAttrs}
                            type={field.format === "url" ? "url" : "text"}
                            value={text}
                        />
                    );
                break;
            }
            case "number":
                control = (
                    <input
                        {...attrs}
                        type="number"
                        required={required}
                        readOnly={field.readOnly}
                        min={field.min}
                        max={field.max}
                        step={field.step ?? (field.integer ? 1 : "any")}
                        inputMode={field.integer ? "numeric" : "decimal"}
                        value={typeof value === "number" ||
                                typeof value === "string"
                            ? value
                            : ""}
                    />
                );
                break;
            case "bool":
                control = (
                    <input
                        {...attrs}
                        type="checkbox"
                        value="true"
                        checked={value === true}
                        disabled={props.disabled || field.readOnly}
                    />
                );
                break;
            case "enum":
                control = (
                    <select
                        {...attrs}
                        required={required}
                        disabled={props.disabled || field.readOnly}
                    >
                        <option
                            value=""
                            selected={!field.options.some((option) =>
                                option.value === value
                            )}
                        >
                            请选择
                        </option>
                        {field.options.map((option) => (
                            <option
                                value={option.value}
                                selected={option.value === value}
                            >
                                {option.label}
                            </option>
                        ))}
                    </select>
                );
                break;
            case "secret":
                control = (
                    <div class="secret-control">
                        <input
                            {...attrs}
                            type="password"
                            value=""
                            autoComplete="new-password"
                            required={required}
                            readOnly={field.readOnly}
                            minLength={field.minLength}
                            maxLength={field.maxLength}
                            placeholder={preserved
                                ? "已配置，留空保留"
                                : undefined}
                        />
                    </div>
                );
                break;
            case "authorization": {
                const state = props.authorization?.[field.name];
                control = (
                    <div class="authorization-control">
                        <button
                            {...attrs}
                            type="button"
                            disabled
                            aria-busy={state?.state === "pending"}
                        >
                            {state?.state === "pending"
                                ? "正在授权…"
                                : field.buttonLabel ?? "一键授权"}
                        </button>
                        <p
                            id={`${id}-status`}
                            class="field-help"
                            role="status"
                            aria-live="polite"
                        >
                            {state?.message ??
                                authorizationMessage(state?.state)}
                        </p>
                    </div>
                );
                break;
            }
        }
        return (
            <div
                class={`schema-field${
                    field.type === "bool" ? " schema-field-bool" : ""
                }`}
            >
                <label for={id}>
                    {field.label}
                    {field.required && <span class="field-required">必填</span>}
                </label>
                {control}
                {help && <p class="field-help" id={`${id}-help`}>{help}</p>}
                {error && (
                    <p class="field-error" id={`${id}-error`} role="alert">
                        {error}
                    </p>
                )}
            </div>
        );
    }

    return <div class="schema-form">{props.schema.fields.map(renderField)}
    </div>;
}

function authorizationMessage(
    state: AuthorizationStates[string]["state"] | undefined,
): string {
    if (state === "pending") return "正在等待授权结果…";
    if (state === "success") return "授权成功";
    if (state === "error") return "授权失败，请重试";
    return "页面交互就绪后可授权。";
}

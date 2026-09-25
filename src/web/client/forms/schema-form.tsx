/**
 * @jsxRuntime automatic
 * @jsxImportSource hono/jsx/dom
 */
import { useState } from "hono/jsx/dom";
import { Icon } from "../../shared/icons.tsx";
import type { Child } from "hono/jsx";
import {
    type AuthorizationStates,
    type FormAction,
    type FormErrors,
    type FormField,
    type FormValue,
    type FormValues,
    initialFormValues,
    type SourceConfigSchema,
} from "@heimdall/admin-contracts/forms.ts";

export interface SchemaFormProps {
    readonly schema: SourceConfigSchema;
    readonly values?: FormValues;
    readonly errors?: FormErrors;
    readonly existingSecrets?: readonly string[];
    readonly authorization?: AuthorizationStates;
    readonly idPrefix?: string;
    readonly disabled?: boolean;
    readonly onValuesChange: (values: FormValues) => void;
    readonly onAction?: (action: FormAction) => void;
}

/** Controlled host fields. Actions are JSON messages; plugins never supply controls. */
export function SchemaForm(props: SchemaFormProps) {
    const [visibleSecrets, setVisibleSecrets] = useState<
        Readonly<Record<string, boolean>>
    >({});
    const defaults = initialFormValues(props.schema);
    const values = { ...defaults, ...props.values };
    const prefix = props.idPrefix ??
        `config-${encodeURIComponent(props.schema.id)}`;
    function change(name: string, value: FormValue) {
        props.onValuesChange({ ...values, [name]: value });
    }

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
            "aria-invalid": error ? "true" as const : undefined,
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
                    ? (
                        <textarea
                            {...textAttrs}
                            rows={4}
                            value={text}
                            onInput={(event) =>
                                change(field.name, fieldValue(event))}
                        />
                    )
                    : (
                        <input
                            {...textAttrs}
                            type={field.format === "url" ? "url" : "text"}
                            value={text}
                            onInput={(event) =>
                                change(field.name, fieldValue(event))}
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
                        onInput={(event) =>
                            change(field.name, fieldValue(event))}
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
                        onChange={(event) =>
                            change(
                                field.name,
                                (event.currentTarget as HTMLInputElement)
                                    .checked,
                            )}
                    />
                );
                break;
            case "enum":
                control = (
                    <select
                        {...attrs}
                        value={typeof value === "string" ? value : ""}
                        required={required}
                        disabled={props.disabled || field.readOnly}
                        onChange={(event) =>
                            change(field.name, fieldValue(event))}
                    >
                        <option value="">请选择</option>
                        {field.options.map((option) => (
                            <option key={option.value} value={option.value}>
                                {option.label}
                            </option>
                        ))}
                    </select>
                );
                break;
            case "secret": {
                const visible = visibleSecrets[field.name] === true;
                control = (
                    <div class="secret-control">
                        <input
                            {...attrs}
                            type={visible ? "text" : "password"}
                            value={typeof value === "string" ? value : ""}
                            autoComplete="new-password"
                            required={required}
                            readOnly={field.readOnly}
                            minLength={field.minLength}
                            maxLength={field.maxLength}
                            placeholder={preserved
                                ? "已配置，留空保留"
                                : undefined}
                            onInput={(event) =>
                                change(field.name, fieldValue(event))}
                        />
                        <button
                            type="button"
                            class="icon-button"
                            aria-controls={id}
                            aria-pressed={visible ? "true" : "false"}
                            aria-label={`显示${field.label}`}
                            title={`${visible ? "隐藏" : "显示"}${field.label}`}
                            disabled={props.disabled}
                            onClick={() =>
                                setVisibleSecrets((current) => ({
                                    ...current,
                                    [field.name]: !visible,
                                }))}
                        >
                            <Icon name={visible ? "eye-off" : "eye"} />
                        </button>
                    </div>
                );
                break;
            }
            case "authorization": {
                const state = props.authorization?.[field.name];
                control = (
                    <div class="authorization-control">
                        <button
                            {...attrs}
                            type="button"
                            aria-busy={state?.state === "pending"
                                ? "true"
                                : "false"}
                            disabled={props.disabled || field.readOnly ||
                                state?.state === "pending" || !props.onAction}
                            onClick={() => props.onAction?.(field.action)}
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
                                authorizationMessage(
                                    state?.state,
                                    !!props.onAction,
                                )}
                        </p>
                    </div>
                );
                break;
            }
        }
        return (
            <div
                key={field.name}
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
    available: boolean,
): string {
    if (state === "pending") return "正在等待授权结果…";
    if (state === "success") return "授权成功";
    if (state === "error") return "授权失败，请重试";
    return available ? "点击开始授权。" : "此授权操作暂不可用。";
}

function fieldValue(event: Event): string {
    return (event.currentTarget as
        | HTMLInputElement
        | HTMLTextAreaElement
        | HTMLSelectElement).value;
}

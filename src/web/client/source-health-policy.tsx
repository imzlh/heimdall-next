/** @jsxRuntime automatic @jsxImportSource hono/jsx/dom */
import { useId } from "hono/jsx/dom";
import {
    DEFAULT_SOURCE_HEALTH_POLICY,
    type EffectiveSourceHealthPolicy,
    parseSourceHealthPolicy,
    type SourceHealthPolicy,
} from "@heimdall/admin-contracts/source-health.ts";
import { Dropdown } from "./forms/dropdown.tsx";
import { controlValue } from "./dom.ts";

export interface SourceHealthPolicyDraft {
    readonly mode: "inherit" | "custom";
    readonly cooldownSeconds: string;
    readonly authCooldownSeconds: string;
}

/** Preserve incomplete seconds input in the dialog until its parent validates. */
export function sourceHealthPolicyDraft(
    value?: SourceHealthPolicy | null,
): SourceHealthPolicyDraft {
    let policy: SourceHealthPolicy | null = null;
    try {
        policy = parseSourceHealthPolicy(value);
    } catch { /* A quarantined source can explicitly return to inheritance. */ }
    return {
        mode: policy == null ? "inherit" : "custom",
        cooldownSeconds: policy?.cooldownMs === undefined
            ? ""
            : String(policy.cooldownMs / 1000),
        authCooldownSeconds: policy?.authCooldownMs === undefined
            ? ""
            : String(policy.authCooldownMs / 1000),
    };
}

export function readSourceHealthPolicyDraft(
    draft: SourceHealthPolicyDraft,
): SourceHealthPolicy | null {
    if (draft.mode === "inherit") return null;
    if (draft.mode !== "custom") throw new TypeError("请选择有效的健康策略。");
    const cooldownMs = milliseconds(draft.cooldownSeconds, "普通失败冷却");
    const authCooldownMs = milliseconds(
        draft.authCooldownSeconds,
        "认证失败冷却",
    );
    return parseSourceHealthPolicy({
        ...(cooldownMs === undefined ? {} : { cooldownMs }),
        ...(authCooldownMs === undefined ? {} : { authCooldownMs }),
    });
}

export function sameSourceHealthPolicy(
    left?: SourceHealthPolicy | null,
    right?: SourceHealthPolicy | null,
): boolean {
    if (left == null || right == null) return left == null && right == null;
    return left.cooldownMs === right.cooldownMs &&
        left.authCooldownMs === right.authCooldownMs;
}

function milliseconds(value: string, label: string): number | undefined {
    const text = value.trim();
    if (!text) return undefined;
    if (!/^\d+(?:\.\d{1,3})?$/.test(text)) {
        throw new TypeError(`${label}必须是 0 至 86400 秒，最多保留三位小数。`);
    }
    const [whole, fraction = ""] = text.split(".");
    const result = Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
    if (!Number.isSafeInteger(result) || result > 86_400_000) {
        throw new TypeError(`${label}必须是 0 至 86400 秒。`);
    }
    return result;
}

export function SourceHealthPolicyEditor(
    { value, effectivePolicy, disabled, invalid, onChange }: {
        readonly value: SourceHealthPolicyDraft;
        readonly effectivePolicy?: EffectiveSourceHealthPolicy;
        readonly disabled?: boolean;
        readonly invalid?: boolean;
        readonly onChange: (value: SourceHealthPolicyDraft) => void;
    },
) {
    const id = `source-health-policy-${useId()}`;
    const effective = effectivePolicy ?? DEFAULT_SOURCE_HEALTH_POLICY;
    return (
        <section class="source-health-policy-field" aria-label="健康策略">
            <span class="field-label">健康策略</span>
            <Dropdown
                value={value.mode}
                dataName="source-health-mode"
                ariaLabel="健康策略使用方式"
                describedBy={`${id}-help`}
                disabled={disabled}
                options={[
                    { value: "inherit", label: "继承全局健康策略" },
                    { value: "custom", label: "自定义此渠道" },
                ]}
                onChange={(mode) => {
                    if (
                        !disabled && (mode === "inherit" || mode === "custom")
                    ) onChange({ ...value, mode });
                }}
            />
            <p class="field-help" id={`${id}-help`}>
                当前生效：普通失败 {effective.cooldownMs / 1000} 秒，认证失败
                {" "}
                {effective.authCooldownMs / 1000} 秒。
            </p>
            {value.mode === "custom" && (
                <div class="source-health-policy-inputs">
                    <label>
                        普通失败冷却（秒）
                        <input
                            name="source-health-cooldown"
                            type="number"
                            min="0"
                            max="86400"
                            step="0.001"
                            placeholder="留空继承全局"
                            value={value.cooldownSeconds}
                            disabled={disabled}
                            aria-invalid={invalid ? "true" : "false"}
                            aria-describedby={`${id}-details`}
                            onInput={(event) => {
                                if (!disabled) {
                                    onChange({
                                        ...value,
                                        cooldownSeconds: controlValue(event),
                                    });
                                }
                            }}
                        />
                    </label>
                    <label>
                        认证失败冷却（秒）
                        <input
                            name="source-health-auth-cooldown"
                            type="number"
                            min="0"
                            max="86400"
                            step="0.001"
                            placeholder="留空继承全局"
                            value={value.authCooldownSeconds}
                            disabled={disabled}
                            aria-invalid={invalid ? "true" : "false"}
                            aria-describedby={`${id}-details`}
                            onInput={(event) => {
                                if (!disabled) {
                                    onChange({
                                        ...value,
                                        authCooldownSeconds: controlValue(
                                            event,
                                        ),
                                    });
                                }
                            }}
                        />
                    </label>
                </div>
            )}
            <p class="field-help" id={`${id}-details`}>
                留空的项继承全局，0
                表示关闭该类冷却。修改只影响后续失败判断，当前倒计时会保留；需要立即恢复请使用「解除冷却」。
            </p>
        </section>
    );
}

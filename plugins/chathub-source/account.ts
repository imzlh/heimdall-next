import type { JsonObject } from "@heimdall/contracts";
import type { ChatHubMeterError, ChatHubThrottling } from "./protocol/types.ts";

import {
    CHATHUB_METER_LABELS,
    type ChatHubQuota,
    type ChatHubQuotaMeter,
} from "./account-view.ts";
export type { ChatHubQuota } from "./account-view.ts";

/** Redact the credentials used for this turn, including any freshly renewed token. */
export function redactChatHubAccount(
    text: string,
    secrets: {
        readonly accessToken: string;
        readonly refreshToken?: string;
        readonly oid: string;
        readonly tid: string;
    },
): string {
    const privateValues = [
        secrets.accessToken,
        secrets.refreshToken,
        secrets.oid,
        secrets.tid,
    ]
        .filter((value): value is string => Boolean(value))
        .flatMap((value) => [value, encodeURIComponent(value)])
        .sort((left, right) => right.length - left.length);
    for (const value of new Set(privateValues)) {
        text = text.replaceAll(value, "[redacted]");
    }
    return text;
}

/** Account counters belong to this provider, outside the inference response. */
export function buildChatHubQuota(
    throttling: ChatHubThrottling | undefined,
    meteringInformation: readonly ChatHubMeterError[] | undefined,
    redact: (text: string) => string = (text) => text,
): ChatHubQuota | undefined {
    const meters: ChatHubQuotaMeter[] = [];
    // Reasoning is the default engine now (gpt-5.6-sol/medium), and its turn
    // quota (`ReasoningModelTurnUsage`, ~10/period per copilot2api SPEC 07 §1.2)
    // is far tighter than the message/image pools — surface it so depletion is
    // visible before the next turn silently degrades.
    for (
        const name of [
            "LLMOnly",
            "ImageGeneration",
            "ReasoningModelTurnUsage",
        ] as const
    ) {
        const remaining = throttling?.metering?.[name]?.remainingAllowance;
        if (
            typeof remaining === "number" && Number.isFinite(remaining) &&
            remaining >= 0
        ) {
            meters.push({
                name,
                remaining,
                ...(remaining === 0 ? { blocked: true } : {}),
            });
        }
    }
    let denials = 0;
    for (const info of meteringInformation ?? []) {
        if (
            info.hasAccess === false ||
            (typeof info.meterError === "string" && info.meterError.trim())
        ) {
            const error = typeof info.meterError === "string"
                ? redact(info.meterError).trim().slice(0, 160)
                : undefined;
            meters.push({
                name: "access",
                blocked: true,
                ...(error ? { error } : {}),
            });
            if (++denials === 8) break;
        }
    }
    return meters.length ? { meters } : undefined;
}

/** Deliberate public projection; credentials and account IDs never enter the UI. */
export function chatHubAccountSnapshot(
    label: string | undefined,
    quota: ChatHubQuota | undefined,
    updatedAt: string | undefined,
): JsonObject {
    const numeric =
        quota?.meters.filter((meter) => meter.remaining !== undefined) ?? [];
    const summary = numeric.map((meter) =>
        `${CHATHUB_METER_LABELS[meter.name] ?? meter.name}：${meter.remaining}${
            meter.blocked ? "（不可用）" : ""
        }`
    );
    if (
        quota?.meters.some((meter) =>
            meter.error || (meter.blocked && meter.remaining === undefined)
        )
    ) {
        summary.push("上游限制了部分能力，请查看账号详情");
    }
    return {
        account: {
            label: label?.trim().slice(0, 256) || "Microsoft 账号",
            summary: summary.join(" · ") ||
                "尚无额度快照，完成一次对话后更新。",
            updatedAt: updatedAt ?? null,
            updatedSummary: updatedAt && Number.isFinite(Date.parse(updatedAt))
                ? `额度更新：${
                    new Date(updatedAt).toISOString().slice(0, 19).replace(
                        "T",
                        " ",
                    )
                } UTC`
                : "尚未获取账号额度",
            meters: (quota?.meters ?? []).map((meter) => ({ ...meter })),
        },
    };
}

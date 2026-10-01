/** Browser-safe account view contract shared by the source and its UI module. */
export interface ChatHubQuotaMeter {
    name: string;
    remaining?: number;
    blocked?: boolean;
    error?: string;
}

export interface ChatHubQuota {
    meters: ChatHubQuotaMeter[];
}

export const CHATHUB_METER_LABELS: Readonly<Record<string, string>> = {
    LLMOnly: "消息额度",
    ImageGeneration: "图片额度",
    ReasoningModelTurnUsage: "深度思考额度",
};

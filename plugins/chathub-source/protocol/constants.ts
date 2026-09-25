export const RECORD_SEPARATOR = "";
export const CHATHUB_ENDPOINT =
    "wss://substrate.office.com/m365Copilot/Chathub";
export const SIGNALR_PROTOCOL = "json";
export const SIGNALR_VERSION = 1;
export const DEFAULT_INVOCATION_ID = "0";

export enum SignalRMessageType {
    Invocation = 1,
    StreamItem,
    Completion,
    StreamInvocation,
    CancelInvocation,
    Ping,
    Close,
}

export type SignalRMessageTypeValue =
    (typeof SignalRMessageType)[keyof typeof SignalRMessageType];

export const ChatHubTarget = {
    Chat: "chat",
    Update: "update",
    Metrics: "Metrics",
    AttachToSession: "AttachToSession",
} as const;

export const DEFAULT_PLUGINS = [
    { Id: "BingWebSearch", Source: "BuiltIn" },
] as const;

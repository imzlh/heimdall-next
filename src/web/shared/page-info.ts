export type ConsolePage =
    | "overview"
    | "channels"
    | "logs"
    | "requests"
    | "settings"
    | "plugin";

const pages = {
    overview: { label: "总览", description: "服务状态、渠道连接与插件能力。" },
    channels: {
        label: "渠道",
        description: "查看上游连接与健康状态，按预设完成配置。",
    },
    settings: {
        label: "设置",
        description: "按功能调整实例配置，变更保存后生效。",
    },
    logs: {
        label: "日志",
        description: "服务运行与管理操作的事件流水，用于审计与排障。",
    },
    plugin: { label: "扩展", description: "已安装插件提供的工作区。" },
    requests: {
        label: "请求记录",
        description: "查看模型请求、响应与用量，追踪单次调用。",
    },
} as const;

/** Keep SSR and the interactive console's page identity consistent. */
export function consolePageInfo(page: ConsolePage, pluginTitle?: string) {
    const info = pages[page];
    return {
        ...info,
        label: page === "plugin" ? pluginTitle || info.label : info.label,
    };
}

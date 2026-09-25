import type { ConsoleSnapshot } from "@heimdall/admin-contracts/console.ts";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import type { UiContribution } from "@heimdall/admin-contracts/ui.ts";

const openAiCapabilities = [
    "generation.create",
    "completion.create",
    "embedding.create",
    "image.generate",
    "image.edit",
    "streaming",
    "tools",
    "structured_output",
    "image.input",
];
const anthropicCapabilities = [
    "generation.create",
    "streaming",
    "tools",
    "structured_output",
    "image.input",
];
const chathubCapabilities = ["generation.create", "streaming", "tools"];

/** Fixed, invented JSON DTOs: the preview never reads an instance or credentials. */
export const snapshot: ConsoleSnapshot = {
    dashboard: {
        health: { status: "ok" },
        authRequired: false,
        models: [
            { id: "atlas-chat", owned_by: "示例服务" },
            { id: "atlas-reasoning", owned_by: "示例服务" },
            { id: "atlas-embedding", owned_by: "示例服务" },
            { id: "orion-chat", owned_by: "示例服务" },
        ],
        status: {
            sources: [
                {
                    id: "openai-compatible",
                    name: "主力模型服务",
                    priority: 10,
                    sourcePluginId: "heimdall.source.openai-compatible",
                    enabled: true,
                    instanceEnabled: true,
                    pluginEnabled: true,
                    capabilities: openAiCapabilities,
                    health: "healthy",
                    models: [
                        "atlas-chat",
                        "atlas-reasoning",
                        "atlas-embedding",
                    ],
                    probe: { ok: true, message: "连接正常 · 示例结果" },
                },
                {
                    id: "anthropic",
                    name: "备用推理服务",
                    priority: 0,
                    sourcePluginId: "heimdall.source.anthropic",
                    enabled: true,
                    instanceEnabled: true,
                    pluginEnabled: true,
                    capabilities: anthropicCapabilities,
                    health: "cooldown",
                    models: ["orion-chat"],
                    probe: { ok: false, message: "等待下一次探测 · 示例结果" },
                },
                {
                    id: "chathub-preview",
                    name: "团队 ChatHub",
                    priority: 5,
                    sourcePluginId: "heimdall.source.chathub",
                    enabled: false,
                    instanceEnabled: false,
                    pluginEnabled: true,
                    capabilities: chathubCapabilities,
                    models: ["示例默认模型"],
                    health: "disabled",
                },
            ],
            plugins: [
                {
                    id: "heimdall.source.openai-compatible",
                    name: "OpenAI 兼容来源",
                    description:
                        "连接 OpenAI 兼容接口，提供对话、向量、图像与工具调用能力。",
                    kind: "source",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: openAiCapabilities,
                    dependencies: [],
                    canToggle: true,
                    managed: false,
                    enabled: true,
                },
                {
                    id: "heimdall.source.anthropic",
                    name: "Anthropic 来源",
                    description:
                        "连接 Anthropic Messages 接口，支持流式输出、图片输入与工具调用。",
                    kind: "source",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: anthropicCapabilities,
                    dependencies: [],
                    canToggle: true,
                    managed: false,
                    enabled: true,
                },
                {
                    id: "heimdall.source.chathub",
                    name: "Microsoft ChatHub",
                    description:
                        "通过 Microsoft ChatHub 连接上游对话，支持流式输出与工具调用。",
                    kind: "source",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: chathubCapabilities,
                    dependencies: [],
                    canToggle: true,
                    managed: false,
                    enabled: true,
                },
                {
                    id: "heimdall.preset.newapi",
                    name: "NewAPI 预设",
                    description:
                        "在添加渠道的模态内快速填写 NewAPI 地址和密钥。",
                    kind: "preset",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: ["source.openai-compatible"],
                    dependencies: [],
                    canToggle: false,
                    managed: false,
                    enabled: true,
                },
                {
                    id: "heimdall.preset.chathub",
                    name: "Microsoft ChatHub 预设",
                    description:
                        "在添加渠道的模态内完成 Microsoft 授权并保存 ChatHub 渠道。",
                    kind: "preset",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: ["source.chathub"],
                    dependencies: [
                        "heimdall.source.chathub",
                        "heimdall.api.chathub-auth",
                    ],
                    canToggle: false,
                    managed: false,
                    enabled: true,
                },
                {
                    id: "heimdall.api.chathub-auth",
                    name: "Microsoft ChatHub 授权服务",
                    description: "为 ChatHub 预设提供账号授权与回调交换接口。",
                    kind: "api",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: [],
                    dependencies: [],
                    canToggle: false,
                    managed: false,
                    enabled: true,
                },
                {
                    id: "heimdall.tool.web",
                    name: "网页搜索与抓取",
                    description:
                        "为 Chat 提供网页搜索和正文抓取；停用后，后续对话不再暴露这些工具。",
                    kind: "tool",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: ["fetch_url", "web_search"],
                    dependencies: [],
                    canToggle: true,
                    managed: false,
                    enabled: true,
                },
                {
                    id: "heimdall.tool.clock",
                    name: "当前时间",
                    description: "为 Chat 提供当前时间工具，无需联网即可使用。",
                    kind: "tool",
                    version: "0.1.0",
                    trust: "trusted",
                    capabilities: ["current_time"],
                    dependencies: [],
                    canToggle: true,
                    managed: false,
                    enabled: true,
                },
            ],
            presets: [{
                id: "heimdall.preset.newapi",
                name: "NewAPI",
                sourcePluginId: "heimdall.source.openai-compatible",
            }, {
                id: "heimdall.preset.chathub",
                name: "Microsoft ChatHub",
                sourcePluginId: "heimdall.source.chathub",
            }],
            managed: [],
        },
        errors: { health: "", models: "", status: "", presets: "", source: "" },
    },
    requests: [
        {
            requestId: "preview-1",
            model: "atlas-chat",
            status: "completed",
            receivedAt: "2026-09-24T10:42:18Z",
        },
        {
            requestId: "preview-2",
            model: "atlas-reasoning",
            status: "completed",
            receivedAt: "2026-09-24T10:40:05Z",
        },
        {
            requestId: "preview-3",
            model: "orion-chat",
            status: "error",
            receivedAt: "2026-09-24T10:36:42Z",
        },
    ],
    usage: { usage: { totalTokens: 128640 } },
    settings: {
        settings: {
            proxyKeyConfigured: true,
            limitPerMinute: 120,
            probeIntervalMs: 300000,
        },
        etag: '"preview-settings-v1"',
    },
    errors: { requests: "", usage: "", settings: "" },
};

export const contributions: readonly UiContribution[] = [
    {
        pluginId: "heimdall.preset.newapi",
        id: "usage",
        slot: "dashboard.widget",
        title: "本月用量 · 示例数据",
        description: "示例插件在总览卡片中提供补充指标。",
        schema: {
            blocks: [
                {
                    kind: "metric",
                    label: "本月请求",
                    value: "1,286",
                    unit: "次",
                    tone: "neutral",
                },
                { kind: "badge", label: "额度充足", tone: "success" },
                { kind: "link", label: "查看渠道", href: "#channels" },
            ],
        },
    },
    {
        pluginId: "heimdall.preset.newapi",
        id: "connection",
        slot: "source.status",
        sourcePluginId: "heimdall.source.openai-compatible",
        title: "渠道补充状态",
        schema: {
            blocks: [
                { kind: "badge", label: "已配置密钥 · 示例", tone: "success" },
                {
                    kind: "text",
                    text: "此区域用于展示当前渠道的授权、额度或同步状态。",
                },
            ],
        },
    },
    {
        pluginId: "heimdall.preset.newapi",
        id: "settings",
        slot: "settings.section",
        title: "NewAPI 配置说明",
        schema: {
            blocks: [
                {
                    kind: "text",
                    text:
                        "请求上限和探测间隔由实例设置统一管理。渠道密钥留空时保留已有配置。",
                },
                {
                    kind: "action",
                    label: "同步插件状态（示例）",
                    action: { id: "refresh-status", payload: {} },
                },
            ],
        },
    },
    {
        pluginId: "heimdall.preset.newapi",
        id: "guide",
        slot: "nav.tab",
        title: "NewAPI 工作区",
        description: "示例插件专属页，使用宿主统一排版与导航。",
        schema: {
            blocks: [
                { kind: "badge", label: "设计预览", tone: "neutral" },
                {
                    kind: "text",
                    text:
                        "在添加渠道模态填写名称和优先级，选择 NewAPI 后，在同一模态内填写连接信息并保存；保存后关闭模态并刷新渠道列表。",
                },
                { kind: "metric", label: "已关联渠道", value: "1", unit: "个" },
                { kind: "link", label: "查看配置流程", href: "#flow" },
            ],
        },
    },
];

export const detailsSchema: SourceConfigSchema = {
    version: 1,
    id: "preview.details",
    fields: [
        { type: "string", name: "name", label: "渠道名称", required: true },
        {
            type: "number",
            name: "priority",
            label: "优先级",
            integer: true,
            required: true,
        },
    ],
};

export const catalogueSchema: SourceConfigSchema = {
    version: 1,
    id: "preview.controls",
    fields: [{
        type: "group",
        id: "common",
        label: "基础字段与校验",
        help: "分组由 schema 描述；标签、间距和错误提示由宿主统一提供。",
        fields: [
            {
                type: "string",
                name: "displayName",
                label: "文本 string",
                required: true,
                maxLength: 80,
                placeholder: "填写便于辨认的名称",
            },
            {
                type: "secret",
                name: "apiKey",
                label: "密钥 secret",
                preserveOnBlank: true,
                help: "只展示配置状态，不回填明文。",
            },
            {
                type: "number",
                name: "limit",
                label: "数值 number",
                default: 120,
                min: 0,
                max: 10000,
                integer: true,
                help: "支持范围和整数约束。",
            },
            {
                type: "enum",
                name: "mode",
                label: "枚举 enum",
                default: "balanced",
                options: [
                    { value: "balanced", label: "均衡模式" },
                    { value: "priority", label: "优先模式" },
                ],
            },
            {
                type: "bool",
                name: "enabled",
                label: "开关 bool",
                default: true,
                help: "标签与原生复选框关联。",
            },
            {
                type: "string",
                name: "notes",
                label: "多行文本",
                multiline: true,
                default: "团队共享的上游服务\n仅用于展示排版",
            },
        ],
    }, {
        type: "group",
        id: "authorization",
        label: "授权 authorization · 四种状态",
        help:
            "宿主授权控件的通用状态。ChatHub 预设的专属授权步骤见上方模态示例。",
        fields: ["idle", "pending", "success", "error"].map((state) => ({
            type: "authorization" as const,
            name: state,
            label: {
                idle: "未授权",
                pending: "授权进行中",
                success: "授权成功",
                error: "授权失败",
            }[state]!,
            buttonLabel: "一键授权",
            action: { id: "preview.authorize" },
        })),
    }],
};

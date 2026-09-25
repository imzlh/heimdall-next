import type {
    FormField,
    SourceConfigSchema,
} from "@heimdall/admin-contracts/forms.ts";

const apiKey: FormField = {
    type: "secret",
    name: "apiKey",
    label: "API 密钥",
    preserveOnBlank: true,
    help: "密钥只写入，不会返回页面。",
};

const mappings: readonly FormField[] = [
    {
        type: "string",
        name: "modelMap",
        label: "模型映射",
        format: "string-map",
        default: "{}",
        help: '填写 JSON 对象，例如 {"对外模型名":"上游模型名"}。',
    },
    {
        type: "string",
        name: "headers",
        label: "附加请求头",
        format: "string-map",
        default: "{}",
        help: "填写 JSON 对象；仅用于非敏感请求头，认证信息请使用 API 密钥。",
    },
];

const openai: SourceConfigSchema = {
    version: 1,
    id: "heimdall.source.openai-compatible",
    title: "OpenAI 兼容渠道",
    fields: [
        {
            type: "group",
            id: "connection",
            label: "连接参数",
            fields: [
                {
                    type: "string",
                    name: "baseUrl",
                    label: "服务地址",
                    format: "url",
                    required: true,
                    placeholder: "https://api.openai.com/v1",
                    help: "填写包含路径前缀的完整地址，不含密钥或查询参数。",
                },
                apiKey,
            ],
        },
        {
            type: "group",
            id: "raw",
            label: "原始参数",
            fields: [
                {
                    type: "string",
                    name: "endpoint",
                    label: "对话接口路径",
                    default: "/chat/completions",
                    help: "以 / 开头，接在服务地址之后。",
                },
                {
                    type: "enum",
                    name: "compat",
                    label: "接口能力",
                    default: "full",
                    options: [
                        { value: "full", label: "全部能力" },
                        { value: "chat", label: "对话与补全" },
                        { value: "embeddings", label: "向量嵌入" },
                        { value: "images", label: "图像生成与编辑" },
                    ],
                },
                ...mappings,
            ],
        },
    ],
};

const anthropic: SourceConfigSchema = {
    version: 1,
    id: "heimdall.source.anthropic",
    title: "Anthropic 渠道",
    fields: [
        {
            type: "group",
            id: "connection",
            label: "连接参数",
            fields: [
                {
                    type: "string",
                    name: "baseUrl",
                    label: "服务地址",
                    format: "url",
                    default: "https://api.anthropic.com",
                    help: "留空时使用 Anthropic 官方地址，不含 /v1/messages。",
                },
                apiKey,
            ],
        },
        {
            type: "group",
            id: "raw",
            label: "原始参数",
            fields: [
                {
                    type: "string",
                    name: "endpoint",
                    label: "消息接口路径",
                    default: "/v1/messages",
                    help: "以 / 开头，接在服务地址之后。",
                },
                {
                    type: "string",
                    name: "anthropicVersion",
                    label: "Anthropic API 版本",
                    default: "2023-06-01",
                    help: "对应 anthropic-version 请求头。",
                },
                ...mappings,
            ],
        },
    ],
};

const newApi: SourceConfigSchema = {
    version: 1,
    id: "heimdall.preset.newapi",
    title: "NewAPI 快速配置",
    fields: [
        {
            type: "string",
            name: "baseUrl",
            label: "NewAPI 服务地址",
            format: "url",
            required: true,
            placeholder: "https://your-newapi.example/v1",
            help: "填写 NewAPI 的 API 地址，通常以 /v1 结尾。",
        },
        apiKey,
    ],
};

/** Legacy records do not expose plugin identity; only known built-in IDs are mapped. */
export function sourcePluginIdFor(sourceId: string): string | undefined {
    switch (sourceId) {
        case "openai-compatible":
        case "newapi":
        case "heimdall.source.openai-compatible":
            return "heimdall.source.openai-compatible";
        case "anthropic":
        case "heimdall.source.anthropic":
            return "heimdall.source.anthropic";
        default:
            return undefined;
    }
}

/** Pure built-in declarations shared by SSR and DOM; unknown identities get no guessed fields. */
export function sourceConfigSchema(sourceId: string): SourceConfigSchema {
    switch (sourcePluginIdFor(sourceId)) {
        case "heimdall.source.openai-compatible":
            return openai;
        case "heimdall.source.anthropic":
            return anthropic;
        default:
            return {
                version: 1,
                id: sourceId,
                title: "未声明配置字段",
                fields: [],
            };
    }
}

export function presetConfigSchema(
    presetId: string,
): SourceConfigSchema | null {
    return presetId === "heimdall.preset.newapi" ? newApi : null;
}

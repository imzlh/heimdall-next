import type {
    ListedPlugin,
    ListedSource,
} from "@heimdall/admin-contracts/console.ts";

export interface CatalogState {
    label: string;
    tone: "green" | "amber" | "muted";
}

export function sourceState(source: ListedSource): CatalogState {
    if (source.instanceEnabled === false) {
        return { label: "已停用", tone: "muted" };
    }
    if (source.pluginEnabled === false) {
        return { label: "插件已停用", tone: "muted" };
    }
    if (!source.enabled) return { label: "已停用", tone: "muted" };
    if (source.health === "cooldown") {
        return { label: "冷却中", tone: "amber" };
    }
    if (source.probe?.ok === false) {
        return { label: "探测异常", tone: "amber" };
    }
    if (
        source.probe?.ok ||
        ["ready", "ok", "available"].includes(source.health ?? "")
    ) return { label: "可用", tone: "green" };
    return { label: "已启用", tone: "muted" };
}

/** An instance switch remains independent of its source plugin's switch. */
export function sourceInstanceEnabled(source: ListedSource): boolean {
    return source.instanceEnabled ?? source.enabled ?? false;
}

/** Long UUIDs read as noise in dense lists; keep a copyable prefix instead. */
export function shortSourceId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

export function sourceAvailabilityText(source: ListedSource): string {
    if (source.pluginEnabled === false) {
        return "源插件已停用，此渠道暂不可用。";
    }
    if (!sourceInstanceEnabled(source)) return "此渠道已暂停接收新请求。";
    return sourceProbeText(source);
}

export function sourceProbeText(source: ListedSource): string {
    if (!source.probe) return "尚无探测结果";
    const result = source.probe.ok ? "最近探测通过" : "最近探测失败";
    return source.probe.message
        ? `${result} · ${source.probe.message}`
        : result;
}

export function pluginState(plugin: ListedPlugin): CatalogState {
    if (plugin.lastError) {
        return {
            label: plugin.enabled === false ? "加载失败" : "运行异常",
            tone: "amber",
        };
    }
    if (plugin.enabled === undefined) {
        return { label: "状态未知", tone: "muted" };
    }
    return plugin.enabled
        ? { label: "运行中", tone: "green" }
        : { label: "已停用", tone: "muted" };
}

export function canTogglePlugin(plugin: ListedPlugin): boolean {
    return plugin.canToggle === true && typeof plugin.enabled === "boolean";
}

export function pluginManagementText(plugin: ListedPlugin): string {
    if (canTogglePlugin(plugin)) return "允许在线启停";
    if (plugin.canToggle === true) return "状态未知，刷新后可操作";
    if (plugin.canToggle === false) return "此插件不支持在线启停";
    return "未提供在线管理能力";
}

export function pluginDependencyState(
    id: string,
    plugins: readonly ListedPlugin[],
): CatalogState {
    const dependency = plugins.find((plugin) => plugin.id === id);
    return dependency
        ? pluginState(dependency)
        : { label: "未注册", tone: "amber" };
}

export function pluginCapabilityLabel(capability: string): string {
    const labels: Record<string, string> = {
        "generation.create": "对话生成",
        "completion.create": "文本补全",
        "embedding.create": "向量嵌入",
        "image.generate": "图像生成",
        "image.edit": "图像编辑",
        "image.input": "图片输入",
        "structured_output": "结构化输出",
        streaming: "流式输出",
        tools: "工具调用",
        current_time: "当前时间",
        web_search: "网页搜索",
        fetch_url: "网页读取",
    };
    return Object.hasOwn(labels, capability) ? labels[capability]! : capability;
}

export function pluginKindLabel(kind?: string): string {
    const labels: Record<string, string> = {
        source: "上游源",
        tool: "聊天工具",
        protocol: "协议适配",
        api: "接口扩展",
        middleware: "请求中间件",
        preset: "配置预设",
        ui: "界面扩展",
    };
    return kind && Object.hasOwn(labels, kind)
        ? labels[kind]!
        : kind || "扩展插件";
}

export function pluginTrustLabel(trust?: string): string {
    if (trust === "isolated") return "隔离运行";
    if (trust === "trusted") return "同进程运行";
    return trust || "未声明运行方式";
}

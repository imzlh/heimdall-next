/** Host-owned public model names and their single-hop upstream destinations. */
export type SourceModelMap = Readonly<Record<string, string>>;

/** Shared by the operator API and browser; no provider code is needed. */
export function parseSourceModelMap(value: unknown): SourceModelMap {
    if (value === undefined) return {};
    if (
        !value || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
        throw new TypeError("模型映射必须是对象。");
    }
    if (Object.getOwnPropertySymbols(value).length) {
        throw new TypeError("模型映射只能使用字符串名称。");
    }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
    if (entries.length > 256) {
        throw new TypeError("每个渠道最多配置 256 条模型映射。");
    }
    const result: Record<string, string> = {};
    for (const [rawAlias, descriptor] of entries) {
        if (!("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError("模型映射必须是 JSON 数据。");
        }
        const target = descriptor.value;
        const alias = modelName(rawAlias);
        if (["__proto__", "prototype", "constructor"].includes(alias)) {
            throw new TypeError("模型映射不能使用保留名称。");
        }
        if (Object.hasOwn(result, alias)) {
            throw new TypeError("对外模型名称不能重复。");
        }
        result[alias] = modelName(target);
    }
    return result;
}

function modelName(value: unknown): string {
    if (
        typeof value !== "string" || !value.trim() ||
        value.trim().length > 256 ||
        /[\s\p{Cc}\p{Cf}]/u.test(value.trim())
    ) {
        throw new TypeError(
            "模型名称不能为空、包含空白或控制字符，且不能超过 256 个字符。",
        );
    }
    return value.trim();
}

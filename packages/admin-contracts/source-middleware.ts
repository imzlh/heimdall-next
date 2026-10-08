/** Null inherits the enabled global chain; an array overrides its order. */
export type SourceMiddleware = readonly string[] | null;

/** Serializable host metadata, shared by the API and source settings form. */
export function parseSourceMiddleware(value: unknown): SourceMiddleware {
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value)) {
        throw new TypeError(
            "渠道中间件必须是插件 ID 数组，或 null（继承全局）。",
        );
    }
    if (value.length > 64) {
        throw new TypeError("每个渠道最多选择 64 个中间件。");
    }
    const selected: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
        );
        const id: unknown = descriptor && "value" in descriptor
            ? descriptor.value
            : undefined;
        if (
            typeof id !== "string" || id.length > 128 ||
            !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id)
        ) {
            throw new TypeError("中间件 ID 无效，请选择已安装的中间件插件。");
        }
        if (seen.has(id)) {
            throw new TypeError("同一渠道不能重复选择中间件。");
        }
        seen.add(id);
        selected.push(id);
    }
    return Object.freeze(selected);
}

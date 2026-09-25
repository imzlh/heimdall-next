import { randomUuid } from "./random-id.ts";

export interface SourceSetupSelection {
    readonly name: string;
    readonly priority: number;
    readonly mode: "preset" | "custom";
    readonly presetId?: string;
}

/** Creation identity and choices live only for the lifetime of the dialog. */
export interface SourceSetupDraft extends SourceSetupSelection {
    readonly id: string;
}

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function ownValue(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Copies only basic fields. Re-selecting a preset preserves the creation id. */
export function createSourceSetupDraft(
    selection: SourceSetupSelection,
    id?: string,
): SourceSetupDraft {
    if (
        typeof selection !== "object" || selection === null ||
        Array.isArray(selection)
    ) throw new Error("渠道基础信息格式无效。");
    const name = ownValue(selection, "name");
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
        throw new Error("渠道名称不能为空，且不能超过 120 个字符。");
    }
    const priority = ownValue(selection, "priority");
    if (typeof priority !== "number" || !Number.isSafeInteger(priority)) {
        throw new Error("渠道优先级必须是安全范围内的整数。");
    }
    const mode = ownValue(selection, "mode");
    if (mode !== "preset" && mode !== "custom") {
        throw new Error("请选择预设或自定义渠道。");
    }
    let presetId: string | undefined;
    if (mode === "preset") {
        const value = ownValue(selection, "presetId");
        if (
            typeof value !== "string" || !value.trim() ||
            value.trim().length > 128
        ) throw new Error("预设标识不能为空，且不能超过 128 个字符。");
        presetId = value.trim();
    }
    if (
        id !== undefined && (typeof id !== "string" || !UUID_PATTERN.test(id))
    ) {
        throw new Error("渠道创建标识无效，请重新添加。");
    }
    return {
        id: id ?? randomUuid(),
        name: name.trim(),
        priority,
        mode,
        ...(presetId ? { presetId } : {}),
    };
}

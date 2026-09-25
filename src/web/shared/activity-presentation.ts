/** Use one explicit time zone so the server and browser show the same time. */
export function requestReceivedTime(value?: string): string {
    if (!value) return "时间未知";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
        ? value
        : date.toISOString().slice(0, 19).replace("T", " ");
}

export function requestState(status?: string): {
    label: string;
    tone: "green" | "amber" | "red" | "muted";
} {
    switch (status) {
        case "pending":
            return { label: "等待中", tone: "amber" };
        case "running":
            return { label: "处理中", tone: "amber" };
        case "completed":
            return { label: "已完成", tone: "green" };
        case "error":
            return { label: "失败", tone: "red" };
        case "cancelled":
            return { label: "已取消", tone: "muted" };
        default:
            return { label: status || "未知", tone: "muted" };
    }
}

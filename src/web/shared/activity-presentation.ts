/** Render timestamps in the viewer's local time, like the original console. */
export function requestReceivedTime(value?: string): string {
    if (!value) return "时间未知";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    const pad = (input: number) => String(input).padStart(2, "0");
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${
        pad(date.getSeconds())
    }`;
    const sameYear = date.getFullYear() === new Date().getFullYear();
    const day = sameYear
        ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${
            pad(date.getDate())
        }`;
    return `${day} ${time}`;
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

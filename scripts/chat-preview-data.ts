import type { ChatInitial } from "@heimdall/admin-contracts/chat.ts";

const conversation = {
    id: "preview-current",
    title: "规划一次周末短途旅行",
    createdAt: "2026-09-24T08:00:00.000Z",
    updatedAt: "2026-09-24T08:04:00.000Z",
};

/** Fictional content for layout review; never loaded by the running application. */
export const chatPreview: ChatInitial = {
    authenticated: true,
    available: true,
    conversations: [conversation, {
        id: "preview-writing",
        title: "整理一封项目进展邮件",
        createdAt: "2026-09-23T06:00:00.000Z",
        updatedAt: "2026-09-23T06:10:00.000Z",
    }, {
        id: "preview-reading",
        title: "读书笔记与下一步计划",
        createdAt: "2026-09-22T09:00:00.000Z",
        updatedAt: "2026-09-22T09:05:00.000Z",
    }],
    conversation,
    models: ["示例模型 A", "示例模型 B"],
    selectedModel: "示例模型 A",
    messages: [{
        id: "preview-message-1",
        conversationId: conversation.id,
        role: "user",
        text:
            "想安排一个轻松的周末短途旅行，不赶行程。可以帮我整理一下计划吗？",
        createdAt: "2026-09-24T08:00:00.000Z",
    }, {
        id: "preview-message-2",
        conversationId: conversation.id,
        role: "assistant",
        text: [
            "### 把两天留给一个地方",
            "",
            "尽量减少路上的时间，**每天只安排一件主要的事**。",
            "",
            "| 时间 | 安排 | 节奏 |",
            "| :--- | :--- | :---: |",
            "| 周六上午 | 出发，到住处放好行李 | 从容 |",
            "| 周六下午 | 沿湖散步，找一家当地小店 | 放松 |",
            "| 周日上午 | 公园或展览，午饭后返程 | 留白 |",
            "",
            "> 不必把空闲填满，留一点可以临时改变主意的时间。",
        ].join("\n"),
        createdAt: "2026-09-24T08:01:00.000Z",
    }, {
        id: "preview-message-3",
        conversationId: conversation.id,
        role: "user",
        text:
            "更喜欢自然风景。这是我收集的一张参考图。也给我一份可以保存的 JSON 行程清单吧。",
        attachments: [{ mediaType: "image/png", dataBase64: "" }],
        createdAt: "2026-09-24T08:02:00.000Z",
    }, {
        id: "preview-message-4",
        conversationId: conversation.id,
        role: "assistant",
        text: [
            "可以，把它保存为 `weekend.json`，之后再补上具体地点。",
            "",
            "```json",
            "{",
            '  "主题": "湖边的慢周末",',
            '  "周六": ["出发", "沿湖散步", "当地晚餐"],',
            '  "周日": ["自由活动", "午饭后返程"]',
            "}",
            "```",
            "",
            "出发前只需要确认：",
            "- [x] 想去的方向：自然风景",
            "- [ ] 当天天气与步道开放时间",
            "- [ ] 返程班次、饮水和舒适的鞋",
        ].join("\n"),
        createdAt: "2026-09-24T08:04:00.000Z",
    }],
};

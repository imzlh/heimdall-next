# TODO — 聊天消息操作按钮（复杂逻辑，待接手）

v1 完整参考：`../ui/chat.html` 640–850 行（`.msg-actions` 整行结构）、`../ui/chat.js`
（`deleteMsg` / `openMessageEditor` / `forkMessage` / `switchBranch` / `continueMessage` /
`addReferenceAsset`）。

v2 现状（`src/web/client/chat/messages.tsx` 的 `Message` 组件）：每条用户/助手消息下已有
**复制**、**删除**；最后一条助手回复有**重试**。其余按钮依赖后端/存储改动，暂缓如下，
按实现成本从低到高排列。

## 1. 图片"作为参考图"

v1：`addReferenceAsset(assetId)`，消息里的每张图一个按钮，点一下回到待发送区。

**前置条件（重要）**：v2 附件目前是端到端 base64（上传、存储、会话加载、再发送全是
base64 by value）。把消息里的 base64 复制回草稿会把它原样再传一遍——带宽和 CPU 双输。
v1 网关已改为"存一份、上游拿签名短链"（见 v1 仓库提交 0cfbc47 "Hand images to
upstreams by link instead of by value"）。**先把这套按链接引用的机制移植到 v2**
（上传后返回资产 ID/URL，会话加载不回传 base64，草稿只持有引用），再做本按钮，
按钮逻辑就只是把引用塞回 `state.attachments`。

## 2. 继续生成

v1：`continueMessage(...)`，消息区上方"继续"按钮（chat.html ~636 `.message-recovery`），
用于续写被截断/停止的助手回复。

v2 缺口：`ChatCommand`（`packages/admin-contracts/chat.ts`）需要新增 `"continue"`
类型；后端 `src/http/chat-routes.ts` 的 `/message` 与 `/regenerate` 之外加 `/continue`，
复用最后一轮上下文且**不追加新的 user 消息**。前端 `use-chat.ts`/`controller.ts`
仿照 `regenerate` 加一路。

## 3. 编辑消息并新建分支

v1：`openMessageEditor(tailIndex)` + 编辑对话框（chat.html ~1280，`editor.role/text`），
保存后从该消息重新生成。

v2 缺口：需要一条"截断到第 N 条并重放"的后端命令（或先删后发）。删除消息的
`DELETE /chat/api/message` 已就绪（见 `src/http/chat-routes.ts`），可以组合：
删目标消息之后的所有消息 → 改写/重发。需要想清楚是否保留原分支。

## 4. 从此消息分叉（fork）

v1：`forkMessage(index)`，以该消息为界复制出一条新会话。

v2 缺口：存储层没有 clone；需要 `POST /chat/api/conversations` 支持从既有会话
复制前缀（`packages/storage` 加 `cloneConversation`，或路由层循环 `addMessage`）。

## 5. 分支翻页（上一/下一回复 + N/N 计数）

v1：`switchBranch(msg, 'prev'|'next')`，`branchIndex/branchCount` 显示在动作行最前。

v2 缺口：**消息表是平铺列表，没有分支树**。这是最大的结构改动，建议等 3/4 落地、
确定分支的数据模型（父子指针或分支链）后再做。

---

### 待查（journal 页，非本次改动范围）

`tests/web/journal-page.test.tsx:213` "journal list error retains SSR records and offers
retry, status filters use the stable DTO values" 当前失败：状态筛选选 `error` 后，
期望列表请求 URL 带 `status=error`，实际为 `null`（`AssertionError: null ≠ "error"`）。
controller 的 `filter()`/`loadList()` 表面逻辑看起来会带上（`state.status || undefined`），
需要排查是 api 层丢参、change 事件时序，还是断言取错了 `test.requests.at(-1)`。
journal 页控制器与测试均为未提交的新文件，接手时一并处理。

**同一页面的原生控件替换**：`src/web/client/journal/page.tsx`（岛屿，:107 `<select>`、
:147 checkbox）与 `src/web/pages/journal.tsx`（SSR 兜底，:62 `<select>`）仍是浏览器
原生控件。岛屿侧换成 `forms/dropdown.tsx` + `forms/switch.tsx`（Switch 已就绪，
用法见 `client/system-log/page.tsx`），SSR 兜底换成纯链接胶囊（用法见
`pages/system-log.tsx`）。属 journal 页接手者一并处理。

### 待查（chat messages 类型错误，非本次改动范围）

`deno task check` 当前有 6 个 TS2786 错误，全部在 `src/web/client/chat/messages.tsx`：
`ChatActivityList` / `ChatReasoning` / `ChatCitations` 被报"return type 'unknown' is not
a valid JSX element"（并行改动引入，2026-09-28 发现）。修复后 `deno task check`
即恢复全绿；本批改动（系统日志页 Switch/胶囊化）已单独 `deno check` 通过。

### 待查（图片按链接迁移，非本次改动范围）

`deno task test` 的 check:tests 阶段现有 10 个类型错误，全部集中在图片迁移相关测试：
`tests/plugins/chathub-images.test.ts`（未提交新文件）与
`tests/plugins/anthropic-protocol.test.ts` 使用 `BlobRef` 的 `dataBase64` 字段，而
`packages/storage/ports.ts`（已修改）中的 `BlobRef` 已不再有该字段（按链接引用迁移）。
接手时把这两个测试改为新的 BlobRef 形状（url/assetId 引用），或确认迁移最终形态后统一更新。

### 已完成（2026-09-27）

- 复制 / 重试（原有）
- 删除消息（带确认窗）：`DELETE /chat/api/message?conversationId=&id=` 删除**整段一问一答**
  （用户消息 + 其后的回复/工具消息；删回复侧则连带它的提问），`withConversationRun`
  防并发。UI 点"删除"先弹 `MessageDeleteDialog`（`conversation-dialog.tsx`），确认后
  controller `removeMessage` 按 服务端返回的 ids 本地裁剪。
- 会话导出 Markdown（侧栏底行）。
- 输入框与快捷键提示改为悬浮层（`composer.css` absolute），不占消息区布局空间；
  灵动宽度形变保留。
- 思考等级移入输入胶囊（图标 + 悬浮菜单），设置弹层不再有它。
- 设置弹层瘦身：去掉对话名称（重命名走侧栏）、自动保存状态行与内部模型选择；
  头部模型选择带 CPU 图标。
- **插件开关**：设置弹层新增"插件"区（`/admin/plugins` 投影进 `ChatInitial.tools`），
  按会话开关工具插件 —— `ConversationRecord.disabledTools`（sqlite 列 `disabled_tools`，
  fork 继承），`PATCH /chat/api/conversation` 接收，`service.settleTurn` 过滤后传给上游。
  消息操作按钮悬停才显示（触屏常显）。

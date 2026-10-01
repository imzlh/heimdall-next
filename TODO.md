# TODO — 功能迁移与内核完善

核实日期：2026-09-29。以当前实现和验证结果更新；“已完成”表示下列具体能力已落地，
不表示整个项目或真实浏览器体验已经验收。旧版消息操作参考：`../ui/chat.html`
640–850 行、`../ui/chat.js`（`deleteMsg` / `openMessageEditor` / `forkMessage` /
`switchBranch` / `continueMessage` / `addReferenceAsset`）。

## 进行中：核心模型映射与 Chat 插件槽位

- [ ] **每源基础配置的模型映射**：公开模型名到上游模型名由核心负责，统一目录、
      路由、执行和探测；从旧 provider config
      迁移，并保持请求身份和公开响应模型。
      添加和编辑仍在原模态内，不能在源插件配置表单里重复维护映射。
- [ ] **Chat 输入框和侧栏槽位**：复用 schema/trusted/iframe 的 JSON 契约，
      由插件声明能力部件，随插件和会话开关变化更新。搜索、memory、账号额度不进
      Chat 内核；SSR、动态撤销、动作授权与会话切换都须验证。

## 下一优先项

- [ ] **更多动态插件类型与升级**：当前离线托管包仅支持 `isolated` 工具插件。
      source、middleware、UI 等类型的动态安装、升级/回滚尚未完成；不可达
      artifact 分块也尚无后台回收。不能把内置目录加载等同于动态安装。
- [ ] **中间件生产生命周期验收与每源绑定**：可信目录加载、持久开关及全局执行链
      已接入
      `src/composition/builtins.ts`、`src/composition/middleware-plugins.ts`、
      `src/composition/server.ts`、`packages/kernel/runtime.ts`，Chat
      也共用该链。 `tests/chat-middleware.test.ts` 和
      `tests/kernel-runtime.test.ts` 已有执行测试； 仍需目录加载 → 管理启停 →
      重启恢复的集成覆盖。每源绑定尚缺，不能用全局链替代。
- [ ] **非标准上游传输**：`plugins/openai-source/config.ts` 当前使用 Bearer、 无
      query 的 base URL/endpoint 和非敏感额外请求头；仍缺 Azure deployment、
      `api-version`、`api-key`/自定义认证及 NDJSON。能力应由源插件和 preset
      提供， 保持 HIP 内核与供应商协议分离，探测和执行使用相同配置。
- [ ] **每源健康策略**：冷却原因、截止时间、手动解除与并发结果隔离已经实现；
      当前仍使用全局冷却时长。每源策略和重启后冷却状态持久化尚未实现。
- [ ] **真实浏览器验收**：Hono JSX 注水、同模态 preset 授权/探测、焦点和
      Escape、
      中文输入法、窄屏/触屏、深浅色、灵动输入框动画及减少动态效果偏好。SSR
      HTML、 类型和 DOM 模拟测试不能代替浏览器交互验收。

## 已完成：原消息操作清单

- [x] **图片资产引用与“作为参考图”**：上传一次，SHA-256 去重、SQLite 存储，
      消息与草稿持有 `assetId`；旧 base64
      迁移、上游签名链接和离线本地解析已落地。
      草稿租约、跨标签页恢复和引用回收保留仍被其他分支/会话使用的图片。
      实现：`src/chat/assets.ts`、`src/chat/asset-links.ts`、
      `src/storage/sqlite-assets.ts`、`src/web/client/chat/controller.ts` 的
      `addReference`。
      验证：`tests/chat-assets.test.ts`、`tests/chat-asset-leases.test.ts`、
      `tests/http-chat-assets.test.ts`、`tests/web/chat-attachments.test.ts`、
      `tests/web/chat-controller.test.ts`、`tests/web/chat-message-actions.test.tsx`。
- [x] **继续生成**：HTTP `/continue` 与 WebSocket 共用 `src/chat/service.ts`，
      续写保存为助手消息的新版本，不追加用户消息、不消费输入草稿；失败保留原分支和
      部分结果。UI 对末尾有正文的助手回复显示“继续”。验证：
      `tests/chat-branches.test.ts`、`tests/chat-branch-tools.test.ts`、
      `tests/web/chat-controller.test.ts`、`tests/web/chat-message-actions.test.tsx`。
- [x] **编辑消息并保留历史**：`src/chat/service.ts` 创建消息
      variant，编辑用户消息
      从该位置生成，编辑助手消息直接保存新版本；原分支保持可选。`src/http/chat-routes.ts`
      的 `PATCH /message` 和 WebSocket
      均已接线，编辑框保留失败草稿并处理输入法组合。
      验证：`tests/chat-branches.test.ts`、`tests/web/chat-message-editor.test.tsx`。
- [x] **从任意消息分叉新会话**：`src/storage/sqlite-chat.ts` 的
      `forkConversation` 原子复制选中前缀，生成新
      ID，继承附件引用和会话设置；`src/http/chat-routes.ts` 提供
      `/fork`。验证：`tests/chat-branches.test.ts`、`tests/storage/chat-store.test.ts`、
      `tests/web/chat-controller.test.ts`，包含写入失败回滚和非当前分支分叉。
- [x] **版本翻页与完整分支入口**：消息已有持久化父子路径、variant
      分组及选中状态； `src/web/client/chat/messages.tsx` 提供上一/下一版本和
      N/N， `src/web/client/chat/conversation-branches.tsx`
      可进入全部存活叶路径。
      验证：`tests/chat-branches.test.ts`、`tests/storage/chat-store.test.ts`、
      `tests/web/chat-message-actions.test.tsx`、`tests/web/chat-conversation-branches.test.tsx`，
      覆盖重启、祖先删除后分支可达、版本边界与并发生成锁。
- [x] **历史回复重生成、复制和删除确认**：重生成按实际消息 ID 操作并保留旧版本；
      删除经 `MessageDeleteDialog` 确认，服务端删除该问答轮次并返回实际 IDs。
      实现：`src/web/client/chat/messages.tsx`、`src/web/client/chat/conversation-dialog.tsx`、
      `src/http/chat-routes.ts`。验证：`tests/web/chat-message-actions.test.tsx`、
      `tests/web/chat-controller.test.ts`、`tests/storage/chat-store.test.ts`。
- [x] **会话 Markdown 导出**：侧栏调用
      `src/web/client/chat/export.ts`，保留用户和
      助手消息、略过工具流量。验证：`tests/web/chat-export.test.ts`。
- [x] **按会话启停工具插件**：`src/web/client/chat-app.tsx`
      设置弹层提供插件开关； `disabledTools` 经 `PATCH /conversation` 保存到
      SQLite，分叉继承， `src/chat/service.ts`
      从上游工具目录排除禁用插件。验证：
      `tests/chat-tools.test.ts`、`tests/storage/chat-store.test.ts`。Chat
      核心保持通用， Web Search、Memory 等功能由工具插件提供。
- [x] **灵动输入框与快捷操作实现**：`src/web/client/chat/composer.tsx`、
      `composer.css`
      已实现悬浮胶囊、宽高变化、附件面板、思考等级菜单及快捷键提示；
      消息操作悬停/聚焦显示、触屏常显。`tests/web/chat-composer.test.ts`
      验证中文输入法、 换行与高度伸缩逻辑；真实动画与布局验收仍在上方待办。

## 已完成：本轮管理页面收口

- [x] **离线工具插件安装与生命周期**：本地包预览、安装、启停、卸载、依赖保护、
      KV 持久化及重启恢复已接通。安装路由现已实际挂载到两套管理前缀。
      `tests/http-plugin-packages.test.ts` 通过 cookie 登录桥实际安装包、让 Chat
      调用 Worker，并验证停用、重启恢复和卸载。Worker
      故障主动撤销贡献并保存错误； 宿主独立校验 JSON
      响应，避免插件绕开自身线程中的校验。入口：
      `src/http/plugin-package-routes.ts`、`src/composition/managed-plugins.ts`。
- [x] **渠道模态草稿探测与模型获取**：`source-config-form.tsx` 与两种 preset JSX
      已支持测试、获取模型、重试和跳过测试保存；配置变更不会采用旧结果。验证：
      `tests/source-draft-probe.test.ts`、`tests/web/add-source-flow.test.tsx`、
      `tests/web/chathub-preset-flow.test.ts`。浏览器交互验收仍单列。
- [x] **插件业务状态与 ChatHub 账号部件**：源提供受限脱敏 JSON 快照，host 只负责
      source.status 渲染和错误隔离。Chat
      核心、DTO、历史及客户端已移除供应商额度； ChatHub 账号 TSX
      显示额度、限制和更新时间，另有可复用/复用中的上下文计数。 SSR schema
      同样显示摘要。验证：`tests/source-ui-snapshot.test.ts`、
      `tests/plugins/chathub-account.test.ts`、`tests/plugins/chathub-proxy.test.ts`、
      `tests/web/chathub-account.test.tsx`。
- [x] **持久化保留策略与维护状态**：设置页提供请求/对话保留天数，0
      表示永久保留。 `src/composition/retention-runtime.ts`
      调度有界清理，跳过活跃操作；先持久化资产
      回收候选，再删会话，并检查其他分支、分叉和租约。上次/下次时间、数量和错误
      可见，系统日志只记录维护摘要。两种历史永久保留时仍回收闲置附件。验证：
      `tests/retention-policy.test.ts`、`tests/web/retention-settings.test.tsx`、
      `tests/web/retention-snapshot.test.ts`。
- [x] **渠道冷却可观测与手动解除**：渠道卡显示固定错误类别、截止时间和剩余时间；
      解除冷却只恢复调度资格，不伪造探测成功。新检查尚未完成时不会屏蔽已完成故障，
      旧结果也不能覆盖更新完成结果或手动操作。验证：`tests/source-health-controls.test.ts`、
      `tests/http-source-health.test.ts`、`tests/web/source-health.test.tsx`。

- [x] **请求记录独立入口与控件统一**：`src/web/client/journal/page.tsx` 已复用
      Dropdown/Switch，`src/web/pages/journal.tsx` 使用 SSR
      状态链接，保留查询、切换
      状态时清除翻页/详情。**日志页只展示系统运行日志**；请求记录是独立
      `view=requests`，从总览进入，旧 `log=requests`
      参数无法把日志切成请求记录。
      验证：`tests/web/journal-page.test.tsx`、`tests/web/journal-snapshot.test.tsx`、
      `tests/web/console-record-navigation.test.ts`。
- [x] **总览全量统计**：SSR 和 island 共用 stats API，模型排行不从最近 20 条请求
      推算，“今日”采用服务端自然日。验证：`tests/web/snapshot-stats.test.ts`、
      `tests/web/stats-panels.test.tsx`，包含 25 条请求、时区/跨午夜及局部失败。
- [x] **网关密钥草稿操作**：安全生成、复制、60
      秒遮蔽、页面隐藏即遮蔽、清除确认和
      撤销已具备；空草稿保留旧密钥，保存后清理草稿，API 仅返回
      `proxyKeyConfigured`。
      不提供读取服务端现存密钥的接口。验证：`tests/web/gateway-key-controls.test.tsx`。

## 核实与回归记录

- 2026-09-29 聊天资产、分支、编辑、工具、存储及图片协议适配定向测试通过。
  `chat-snapshot` 的旧 fixture 已区分可展示 reasoning 与内部 raw
  字段，并保留密钥 脱敏检查；修复后连同请求页、总览统计、网关密钥测试重跑： **39
  passed（16 steps），0 failed**。
- 原 journal `status=error` 失败本次通过；原两个图片测试文件的 `BlobRef`
  类型问题
  本次检查与执行均通过。`deno check --config deno.browser.json
  src/web/client/chat/messages.tsx`
  通过，旧 6 个 TS2786 错误已不复现。
- 当前记录仅覆盖本文件审计的定向范围；完整 `deno task verify`
  由本轮集成收口确认。

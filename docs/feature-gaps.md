# 功能迁移缺口与验收

对照日期：2026-09-29。旧版证据位于上一级仓库的 `src/`、`ui/`、`plugins/`。
本文记录端到端能力缺口；已有类型、接口或单元实现不等于生产路径已接通。
验收必须同时覆盖服务端行为、管理接口和需要的操作界面。

## P0 进行中：核心模型映射与 Chat 扩展

- 每源模型映射属于基础配置和核心执行边界，目录、路由、执行、探测都须一致；
  旧插件 `config.modelMap` 要迁移，公开模型名不能被上游名称覆盖。
- Chat 输入框和侧栏通过命名 slot 扩展，复用声明式 schema、可信模块、沙箱及 JSON
  动作契约。插件启停和会话切换应撤销旧内容和动作；搜索、memory、账号信息
  不得变成 Chat 内建业务。当前实现和验收正在推进。

## 已落地：动态工具插件安装、执行和恢复

- 旧版证据：`../src/api/admin/plugins.ts` 的安装接口；
  `../src/plugins/lifecycle.ts` 的安装、启停、卸载和启动恢复。
- Next 现状：`src/composition/managed-plugins.ts` 已有离线 JSON 包解析、
  `ConfigPluginRecordStore` 和隔离 runtimeFactory；
  `src/http/plugin-package-routes.ts` 已挂入管理路由，插件页已接通。
  当前入口只接受 `kind: tool`、`trust: isolated`
  的包，不能称为所有插件类型的动态安装。
- 实现边界：插件执行在隔离运行器中，host
  注册/撤销通用工具贡献；包无需运行时拉包。 多类型托管包（source、middleware、UI
  等）、升级/回滚仍有缺口，不能由内置目录加载 或已有 manifest 类型声明推定完成。
- 验收：安装后实际调用能力；停用后不可调用；重启恢复已启用包；
  失败可见且不残留贡献；卸载解除注册并处理依赖；并发 revision 冲突不覆盖记录。
  `tests/http-plugin-packages.test.ts` 已经过真实 cookie 登录桥安装包、让 Chat
  调用隔离 Worker，并验证重启恢复、停用和卸载；生命周期、依赖、revision 和 恶意
  Worker 响应另有专项测试。真实浏览器操作仍需验收。
- Worker 故障主动撤销工具并落盘错误；无标准退出事件时通过心跳发现静默失活。 KV
  持续不可写时不能保证立即持久化，但不会继续提供故障工具。不可达 artifact
  分块回收、更多插件类型和升级仍是缺口。

## P1：中间件生命周期验收与每源绑定

- 旧版证据：`../src/proxy/forward.ts` 解析渠道中间件绑定并包装执行器。
- Next 现状：`src/composition/builtins.ts` 已加载可信 middleware
  描述并恢复开关； `src/composition/middleware-plugins.ts` 维护全局注册表，
  `src/composition/server.ts` 将其注入 `packages/kernel/runtime.ts`。 协议请求与
  Chat 共用请求/帧转换链，`tests/kernel-runtime.test.ts`、
  `tests/chat-middleware.test.ts` 已覆盖执行和请求上下文。
- 剩余缺口：生产目录加载 → 管理启停 → 重启恢复的集成验收，以及每源绑定策略。
  全局链已接通，不能再记录为“未入执行链”；每源链也不能据此标完成。
- 验收：标准启动加载插件、管理操作即时影响后续请求、开关重启后保留、顺序稳定；
  错误输入和加载失败可见；已有请求按其快照完成，空 registry 保持现有行为。

## 已落地：渠道能力探测与保存前测试

- 旧版证据：`../src/api/admin/channels.ts` 支持未保存表单探测；
  `../src/core/probe/save.ts` 保存能力快照。
- Next 现状：添加模态已接草稿测试、模型获取、失败重试和跳过测试保存，入口为
  `src/web/client/source-config-form.tsx`、`plugins/*-preset/ui.tsx` 和
  `src/composition/source-draft-probe.ts`。
- 实现边界：插件负责网络及端点识别；host 在原添加模态中提供草稿测试。 基础信息 →
  预设/自定义 → 预设 JSX 或 host schema form → 测试/获取模型 → 保存，
  不跳独立页面、不打开新浏览器 Tab。
- 验收：不落盘测试草稿；区分模型列表不可用与推理不可用；失败可重试或明确跳过；
  已验证能力和显式覆盖影响目录与路由；取消、配置变更后不采用过时探测结果；
  超时和错误不泄露密钥。
- 验证：`tests/source-draft-probe.test.ts`、`tests/web/add-source-flow.test.tsx`、
  `tests/web/chathub-preset-flow.test.ts`。真实浏览器操作仍待验收。

## 已落地：ChatHub 插件账号状态与热上下文

- 旧版证据：`../src/api/admin/plugins.ts` 的余额查询；
  `../plugins/chathub/metering-store.ts` 和 `mod.ts` 的实际配额快照；
  `../plugins/newapi-balance/`、`../plugins/openai-balance/`。
- Next 现状：源插件 `uiSnapshot()` 提供受限的公共 JSON，`sourceUiContext`
  只投影当前源。Chat 核心已移除配额 DTO、回复字段及卡片；ChatHub 账号 TSX
  显示额度、限制和更新时间，另有可复用/复用中的热上下文数量。
- 实现边界：插件持有业务状态和刷新逻辑，host 接收脱敏 JSON 并渲染 slot。
- 验收：真实请求更新配额；状态部件显示最近快照和时间；可刷新；
  插件失败不破坏源列表；无密钥进入 SSR 或浏览器 context。
- 以上由
  `tests/source-ui-snapshot.test.ts`、`tests/plugins/chathub-account.test.ts`、
  `tests/plugins/chathub-proxy.test.ts`、`tests/web/chathub-account.test.tsx`
  验证。 当前额度来自实际对话快照，独立额度查询和其他供应商余额插件仍未迁移。

## 已落地：聊天和请求数据保留

- 旧版证据：`../src/services/scheduler.ts` 根据 chatRetentionDays
  清理会话及关联资源，设置页提供保留天数。
- Next 现状：请求和对话保留天数已进入 KV 设置，环境变量只提供初始值。
  `src/composition/retention-runtime.ts` 调度有界维护并保存上次结果；设置页
  SSR/island 展示策略、上次/下次时间、数量和错误。
- 实现边界：持久化保留策略、按最后活动时间分批清理、跳过活跃生成。
- 验收：设置重启后有效；展示维护时间与清理数量；过期记录和不再被引用的附件被清理；
  活跃会话保留；0 天明确表示关闭；删除批次有上限。
- `tests/retention-policy.test.ts` 验证 CAS、重启、最后活动时间、活跃操作跳过、
  分支/分叉/租约保护和失败顺序；UI/API 有专项测试。两项均为 0 时仍回收无引用且
  租约过期的附件，不删除任何历史会话。维护日志只有数量和固定失败原因。

## P1：非标准上游传输

- 旧版证据：`../src/core/upstream-transport.ts` 支持 Azure deployment、
  api-version、api-key/custom auth 和 NDJSON 流格式。
- Next 现状：OpenAI source 主要支持 URL、Bearer 与 endpoint；
  自定义敏感请求头不被允许，不能表达上述认证和 Azure 部署配置。
- 实现边界：增强源插件或新增 Azure 源和 preset；schema 表达参数， 核心继续只处理
  HIP。
- 验收：对应实际请求 URL/认证/流解析正确；探测与执行采用一致配置；
  密钥保持只写；同模态 preset 保存后可用。

## P2：每源健康策略与冷却持久化

- 旧版证据：`../src/router/health.ts` 支持渠道冷却覆盖、401 策略和
  持久化状态；`../src/api/admin/channels.ts` 提供手动恢复。
- Next 现状：冷却原因、截止时间和倒计时已显示；手动解除恢复调度资格而不伪造
  探测成功。操作代次与检查完成顺序保证旧结果不回写，也不被尚未完成的新请求饿死。
  当前仍使用全局时长，缺少每源策略和冷却状态重启恢复。
- 实现边界：复用现有路由器，提供渠道策略和可观测健康快照。
- 验收：冷却原因和倒计时可见；策略影响后续请求；手动恢复行为明确；
  并发探测、取消与重新配置不会写回过时状态。
- 已有状态/恢复行为由 `tests/source-health-controls.test.ts`、
  `tests/http-source-health.test.ts`、`tests/web/source-health.test.tsx` 覆盖。

## 已落地：总览使用完整统计

- `src/web/server/snapshot.ts`、`src/web/client/use-stats.ts` 和
  `src/web/shared/stats-panels.tsx` 共同消费 stats 与 series
  API。模型排行来自全量 汇总，统计日和时区由服务端确定；最近 20
  条请求只是独立的摘要面板。
- 已验证：`tests/web/snapshot-stats.test.ts` 用当天 25 条请求证明汇总不受 20 条
  预览限制；`tests/web/stats-panels.test.tsx` 覆盖
  SSR/island、跨午夜、趋势切换、
  空数据与局部失败。无需再列为“完整统计尚未接入”。

## 已落地：系统日志与独立请求记录

- **日志不能包含请求日志**。`view=logs` 只展示系统运行事件；请求记录位于独立
  `view=requests`，从总览的“最近请求”进入，不能成为日志的 Tab、子页或筛选项。 旧
  `log=requests` 参数也不能改变日志页的数据来源。
- 请求记录已有 SSR/island、搜索/状态筛选、游标翻页、详情/事件帧以及导出入口；
  `src/web/client/journal/page.tsx` 复用 Dropdown/Switch，
  `src/web/pages/journal.tsx` 通过 GET 表单和状态链接保留无 JS 筛选。
- 已验证：`tests/web/console-record-navigation.test.ts` 锁定页面与 API
  读取隔离；
  `tests/web/journal-page.test.tsx`、`tests/web/journal-snapshot.test.tsx`
  覆盖筛选、 详情、失败重试和 SSR
  链接。数据保留与真实浏览器验收仍按各自缺口推进。

## 已落地：网关密钥生成与草稿操作

- `src/web/client/gateway-key.tsx`、`gateway-key-draft.ts` 已提供 256
  位安全随机生成、 复制、60
  秒自动遮蔽、页面隐藏即遮蔽、清除确认/撤销；留空保留旧值，保存后清理草稿。
- 可显露和复制的是刚输入或生成的未保存草稿；**服务端不回读现存密钥**，普通 DTO
  和 SSR 只提供
  `proxyKeyConfigured`。不把旧版读取密钥接口当成当前实现或默认待办。
- 已验证：`tests/web/gateway-key-controls.test.tsx`
  覆盖草稿生命周期、复制失败、迟到 结果、revision 冲突和 API
  投影。网关访问密钥与出站代理池是不同设置。

## 待验收：真实浏览器 UI 与渐进增强

- 本机没有浏览器；SSR HTML、类型、逻辑与 DOM
  模拟测试不能证明真实注水、动画或布局。
- 验收同模态
  preset/授权/探测、插件安装启停、深浅色、窄屏/触屏、键盘焦点、Escape、
  中文输入法、灵动输入框形变及减少动态效果偏好；无 JS 时内容仍可阅读和筛选。

## 已有能力与范围约束

已有渠道 schema 编辑与密钥保留、单模态 preset JSX、代理池和渠道选择、
基本模型发现、自动/手动探测、源启停删除、请求持久化、统计后端、四个 UI slot
基础渲染。上述能力不重复列为缺失。

聊天资产引用、参考图、续写、编辑保留版本、从消息分叉及完整分支入口已经落地，
实现与专项测试见 `../TODO.md`，不能继续按“平铺消息、全程 base64”描述当前存储。

保持 Deno + Hono JSX SSR 和 island；源配置表单由 host
生成；添加流程保持同一模态； 搜索、memory 等 Chat
功能由插件提供。核心只解析全局代理池/源代理选择，插件自行使用， 不替换全局
fetch、不强制插件走代理。签到按此前明确范围暂不搬迁。

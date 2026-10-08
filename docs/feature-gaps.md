# 功能迁移缺口与验收

对照日期：2026-10-01。旧版证据位于上一级仓库的 `src/`、`ui/`、`plugins/`。
本文记录端到端能力缺口；已有类型、接口或单元实现不等于生产路径已接通。
验收必须同时覆盖服务端行为、管理接口和需要的操作界面。

## 已落地：每源基础模型映射与 Chat 扩展

- `modelMap` 已进入每源基础元数据，旧 `config.modelMap` 在交给插件前原子迁移。
  核心 `src/composition/source-model-mapping.ts`
  统一公开目录、路由、探测与执行； 源插件使用解析后的
  `traits.model`，请求身份、公开请求和协议响应仍使用调用方
  模型名。映射只解析一跳，清空后恢复原始目录，不重建源插件的热会话。
- 添加/编辑模态提供映射行，处理重复和空值、清空、CAS 冲突；切换 preset 或
  自定义配置保留基础映射，不在插件原始配置表单重复设置。
- Chat 现有 `chat.composer` / `chat.sidebar` 命名 slot，复用 schema、可信模块、
  沙箱及 JSON 动作契约。Web 工具声明开关和说明；未声明输入区 UI 的工具自动获得
  通用开关。`/admin/chat/ui` 经同源会话授权返回最新目录，island 刷新后撤销停用
  部件和监听。动作只允许当前插件的当前会话开关；搜索、memory、账号信息保持插件
  业务。上下文不含消息正文、草稿、附件或密钥。
- 已验证：`tests/source-model-mapping.test.ts` 覆盖 HTTP、上游模型、公开响应、
  探测、CAS、旧配置迁移、重启和源启停；`tests/web/source-model-map.test.ts`、
  `tests/web/source-management-dialog.test.tsx` 覆盖表单；
  `tests/web/chat-slots.test.tsx` 覆盖 SSR、DOM 切换、动作授权、目录刷新及卸载。
  Chrome 已走通双槽位、开关持久化和模型恢复；剩余真实环境验收见下文。
- `ChatApp` 已补齐增强后的两处槽位挂载；会话过期清空后重新登录，即使目录未变也会
  恢复。工具目录、待发送选择与 API 使用同一个 128 项限额；超限拒绝保存而不截断
  停用项。`tests/chat-tool-selection.test.ts` 覆盖 128 项首次发送、API、SQLite
  重开、分叉和 SSR；不会因插件目录中的其他类型占位而提前截断工具。
- 新建会话会转存发送前选中的模型，刷新可从本机保存恢复，有效链接参数仍优先；
  模型移除后选择当前可用模型。`tests/web/chat-controller.test.ts` 和
  `tests/web/chat-snapshot.test.ts` 已覆盖。
- 启动逐源隔离坏模型映射和连接配置，保留持久记录及原有实例开关；即使坏映射位于
  已停用源的旧 `config.modelMap` 中，也不会阻止健康源启动。目录以
  `configurationErrorField` 指向基础映射或连接配置入口；修复经 CAS 成功后才
  更新隔离状态，旧映射字段同时迁出。改名、启停及无关参数保存不能清除坏映射。
  `tests/source-restoration-errors.test.ts` 覆盖磁盘重开、记录不被删除、隔离、
  冲突和修复，模态对应测试见 `tests/web/source-management-dialog.test.tsx`。

## 已落地：动态工具插件安装、执行和恢复

- 旧版证据：`../src/api/admin/plugins.ts` 的安装接口；
  `../src/plugins/lifecycle.ts` 的安装、启停、卸载和启动恢复。
- Next 现状：`src/composition/managed-plugins.ts` 已有离线 JSON 包解析、
  `ConfigPluginRecordStore` 和隔离 runtimeFactory；
  `src/http/plugin-package-routes.ts` 已挂入管理路由，插件页已接通。
  当前入口只接受 `kind: tool`、`trust: isolated`
  的包，不能称为所有插件类型的动态安装。
- 实现边界：插件执行在隔离运行器中，host 注册/撤销通用工具贡献；包无需运行时
  拉包。已启用工具包的 manifest UI 已动态进入运行目录，重启恢复、停用/卸载撤销；
  可直接使用 schema，manifest 不会授予可信模块执行权限。独立
  source、middleware、 UI 等类型和可执行 UI 资产的托管安装、升级/回滚仍有缺口。
- 验收：安装后实际调用能力；停用后不可调用；重启恢复已启用包；
  失败可见且不残留贡献；卸载解除注册并处理依赖；并发 revision 冲突不覆盖记录。
  `tests/http-plugin-packages.test.ts` 已经过真实 cookie 登录桥安装包、让 Chat
  调用隔离 Worker，并验证重启恢复、停用和卸载；生命周期、依赖、revision 和 恶意
  Worker 响应另有专项测试。Chrome 已实际走通安装、启用、Worker 调用、跨 Tab
  撤销和卸载，范围见下文。
- `tests/managed-plugin-ui.test.ts` 实际安装包并启用，验证 Chat SSR 使用其声明、
  重启恢复、停用和卸载移除 UI，以及无许可的 trusted 声明回退 schema；坏声明
  不会压掉健康插件内容。
- Worker 故障主动撤销工具并落盘错误；无标准退出事件时通过心跳发现静默失活。 KV
  持续不可写时不能保证立即持久化，但不会继续提供故障工具。不可达 artifact
  分块回收、更多插件类型和升级仍是缺口。

## 已落地：每源中间件绑定与生产生命周期

- 旧版证据：`../src/proxy/forward.ts` 解析渠道中间件绑定并包装执行器。
- Next 现状：可信 middleware 由 `src/composition/builtins.ts` 加载，
  `src/composition/middleware-plugins.ts` 管理持久开关和每源绑定，正式 server
  将其注入 `packages/kernel/runtime.ts`。所有协议和 Chat 共用请求/帧转换链。
- 每源基础配置的 `middleware` 明确区分 `null`（继承全局）、`[]`（禁用）和插件 ID
  数组（按所选顺序）；添加、编辑模态已提供选择和排序。全局停用插件不会删除
  每源绑定；重新启用后后续请求恢复使用，目录缺失的插件也保留其绑定信息。
- 执行边界：请求读取一次启用状态和绑定快照；切换或重新配置不会改写进行中的
  请求。故障转移为每个源重新构造输入并分别应用映射，中间件错误不作为上游健康
  故障重试或冷却；错误和取消关闭上游及中间包装流。
- 已验证：`tests/source-middleware.test.ts` 覆盖目录加载、正式服务器执行、管理
  启停、CAS、配置编辑、删除及关闭后重新打开磁盘 KV；
  `tests/kernel-source-middleware.test.ts` 覆盖顺序、快照、故障转移、模型映射、
  取消和资源释放，`tests/chat-middleware.test.ts` 覆盖 Chat 共用链。源绑定
  损坏时隔离该源并提供修复，健康源可继续工作。更多类型的动态安装仍属上方缺口。

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
  `tests/web/chathub-preset-flow.test.ts`。Chrome 已走通同模态 preset
  JSX、自定义 schema、本地网络探测和保存；真实外部 ChatHub 账号授权仍未验收。

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
- 正式启动已恢复崩溃进程遗留的 pending/running 请求为失败状态
  `process_interrupted`，保留帧和用量，旧请求可正常参与清理；单写入者文件锁
  防止并发进程误恢复活跃请求。inline 附件转换与租约/回收候选原子落盘，部分
  转换失败、历史替换失败和重启均可回收无引用副本，原始历史和独立租约不受误删。
  验证：`tests/storage/request-journal-recovery.test.ts`、
  `tests/chat-inline-asset-recovery.test.ts`、`tests/chat-deletion-recovery.test.ts`。

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
  链接。保留及崩溃恢复见上方已落地条目；真实浏览器验收仍单列。

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

## 已验收：真实 Chrome 关键流程与渐进增强

- `deno task test:browser` 先构建自托管浏览器资产，再运行
  `scripts/browser-smoke.ts`。它使用固定版本 `playwright-core@1.55.1` 控制 现有
  Chrome；可用 `HEIMDALL_BROWSER_EXECUTABLE` 指定可执行文件。该依赖
  仅供验收脚本使用，应用服务端和浏览器 bundle 不引入它。
- 场景使用本地模拟上游和内存 KV/SQLite，不读取或改写用户数据库；截图等结果
  写入单独的临时目录。脚本不下载浏览器，所需构建和工具包须事先缓存以离线执行。
- 2026-10-01 在 **Chrome 154.0.8037.58** 执行退出 0，`success: true`、
  `failures: []`。实际验收同模态 preset JSX、本地网络探测/保存、公开模型映射到
  上游且响应保留公开名、自定义 schema 保存及顶层 `middleware: []` / `modelMap`
  持久化、Escape 关闭。
- Chat 双槽位注水、工具开关随会话持久化、刷新保留模型已通过；离线 JSON 包经过
  安装、启用、动态通用 composer 开关和 manifest sidebar、真实 Worker 工具调用、
  停用后的跨 Tab 撤销及卸载。深浅色、390 px 窄屏无横溢出、减少动态效果和禁用 JS
  后双槽位可读均有截图。
- 统计图原内联宽度样式违反 CSP，已改为 SVG 属性；最终浏览器控制台零错误。
  结果及截图目录：`%TEMP%/heimdall-browser-914bd909a72554df`，详见其
  `result.json`。
- 剩余验收：真实外部 ChatHub 账号授权、中文输入法、真触屏以及完整键盘/动画细节。
  本次本地上游与截图验证不能覆盖这些行为，也不代表所有页面交互已经验收。

## 已有能力与范围约束

已有渠道 schema 编辑与密钥保留、单模态 preset JSX、代理池和渠道选择、
基本模型发现及每源映射、自动/手动探测、源启停删除、请求持久化、统计后端、六个 UI
slot 基础渲染。上述能力不重复列为缺失。

聊天资产引用、参考图、续写、编辑保留版本、从消息分叉及完整分支入口已经落地，
实现与专项测试见 `../TODO.md`，不能继续按“平铺消息、全程 base64”描述当前存储。

保持 Deno + Hono JSX SSR 和 island；源配置表单由 host
生成；添加流程保持同一模态； 搜索、memory 等 Chat
功能由插件提供。核心只解析全局代理池/源代理选择，插件自行使用， 不替换全局
fetch、不强制插件走代理。签到按此前明确范围暂不搬迁。

## 集成验证记录

- 2026-10-01 最终 `deno task verify` 退出 0，通过格式、lint、全部类型检查和
  浏览器构建；测试 **1149 passed（129 steps），0 failed**。日志：
  `%TEMP%/heimdall-final-verify.txt`。该结果取代本轮早期 1094 项记录；Chrome
  独立结果及实际范围见上文。

# 功能迁移缺口与验收

对照日期：2026-09-26。旧版证据位于上一级仓库的 `src/`、`ui/`、`plugins/`。
本文记录端到端能力缺口；已有类型、接口或单元实现不等于生产路径已接通。
验收必须同时覆盖服务端行为、管理接口和需要的操作界面。

## P0：动态插件安装、执行和恢复

- 旧版证据：`../src/api/admin/plugins.ts` 的安装接口；
  `../src/plugins/lifecycle.ts` 的安装、启停、卸载和启动恢复。
- Next 现状：插件卡片和生命周期 host 已有，但管理 API 无安装入口；
  默认 composition 未提供 runtimeFactory，包 artifact 仅存在内存。
- 实现边界：本地包校验与持久化、显式信任策略、运行器、贡献注册/撤销。
  可信包采用 host 允许的执行路径，不可信包经隔离运行器。
- 验收：安装后实际调用能力；停用后不可调用；重启恢复已启用包；
  失败可见且不残留贡献；卸载解除注册并处理引用；浏览器可完成操作。

## P0：中间件生产加载与执行

- 旧版证据：`../src/proxy/forward.ts` 解析渠道中间件绑定并包装执行器。
- Next 现状：`packages/kernel/hooks.ts` 的 MiddlewareRegistry 和
  `packages/kernel/runtime.ts` 已实现请求/帧转换，但默认 builtins loader
  未加载 middleware，server composition 未连接该 registry。
- 实现边界：先接通已声明、可信中间件的全局有序执行和动态启停；
  复用 HIP hooks，保留每源绑定的后续扩展边界，不把业务规则放入内核。
- 验收：标准启动加载插件；真实协议请求与 Chat 共用内核执行链；
  启停即时影响后续执行，顺序稳定，重启恢复开关；错误输入和加载失败可见；
  空 registry 保持现有行为。每源绑定另行实现，不能宣称全局链等价于每源链。

## P1：渠道能力探测与保存前测试

- 旧版证据：`../src/api/admin/channels.ts` 支持未保存表单探测；
  `../src/core/probe/save.ts` 保存能力快照。
- Next 现状：基本模型发现已有，但 OpenAI probe 仅 GET `/models`，
  不支持该接口的正常对话源会被视为失败；创建渠道只做配置校验并落盘。
- 实现边界：插件负责网络及端点识别；host 在原添加模态中提供草稿测试。
- 验收：不落盘测试草稿；区分模型列表不可用与推理不可用；
  已验证能力和显式覆盖影响目录与路由；取消、超时和错误不泄露密钥。

## P1：插件状态部件的业务数据

- 旧版证据：`../src/api/admin/plugins.ts` 的余额查询；
  `../plugins/chathub/metering-store.ts` 和 `mod.ts` 的实际配额快照；
  `../plugins/newapi-balance/`、`../plugins/openai-balance/`。
- Next 现状：source.status slot 已有，但内置部件只有通用状态、模型数、
  探测结果；sourceUiContext 没有插件业务快照，余额插件未迁入。
- 实现边界：插件持有业务状态和刷新逻辑，host 接收脱敏 JSON 并渲染 slot。
- 验收：真实请求更新配额；状态部件显示最近快照和时间；可刷新；
  插件失败不破坏源列表；无密钥进入 SSR 或浏览器 context。

## P1：总览使用完整统计

- 旧版证据：`../src/api/admin/stats.ts` 返回完整当天模型汇总。
- Next 现状：后端已有 stats、series、models API；dashboard 仍从最近
  20 条请求统计模型排行，“今日”按浏览器日期匹配服务端日桶。
- 实现边界：SSR 和 island 共同消费现有统计接口，由服务端确定统计日。
- 验收：超过 20 条请求时排行仍准确；跨时区正确；日/周趋势与明细一致；
  空数据和局部加载失败有清楚的状态。

## P1：日志与请求排障

- 旧版证据：`../ui/index.html` 日志页和 `../ui/app.js` 刷新/清空操作。
- Next 现状：ActivityPanel 仅显示最近 20 条摘要；后端已有状态筛选、
  游标和请求/frames 详情，尚未接到完整管理流程。
- 实现边界：复用 journal API，提供日志页、筛选、翻页、详情；清理需补后端。
- 验收：可定位历史失败请求并查看脱敏详情；游标不丢记录；
  刷新、筛选及清理结果可见，清理避开活跃请求。

## P1：聊天和请求数据保留

- 旧版证据：`../src/services/scheduler.ts` 根据 chatRetentionDays
  清理会话及关联资源，设置页提供保留天数。
- Next 现状：maintenance 只清请求 journal，配置来自启动环境变量；
  聊天仅支持手动删除，没有动态保留设置。
- 实现边界：持久化保留策略、按最后活动时间分批清理、跳过活跃生成。
- 验收：设置重启后有效；过期记录和关联附件被清理；
  活跃会话保留；0 天明确表示关闭；删除批次有上限。

## P1：非标准上游传输

- 旧版证据：`../src/core/upstream-transport.ts` 支持 Azure deployment、
  api-version、api-key/custom auth 和 NDJSON 流格式。
- Next 现状：OpenAI source 主要支持 URL、Bearer 与 endpoint；
  自定义敏感请求头不被允许，不能表达上述认证和 Azure 部署配置。
- 实现边界：增强源插件或新增 Azure 源和 preset；schema 表达参数，
  核心继续只处理 HIP。
- 验收：对应实际请求 URL/认证/流解析正确；探测与执行采用一致配置；
  密钥保持只写；同模态 preset 保存后可用。

## P2：渠道健康策略与操作

- 旧版证据：`../src/router/health.ts` 支持渠道冷却覆盖、401 策略和
  持久化状态；`../src/api/admin/channels.ts` 提供手动恢复。
- Next 现状：已有自动探测、手动探测和 failover，但使用全局固定冷却；
  ready/cooldown 只存内存，无截止时间、原因、渠道策略或直接恢复接口。
- 实现边界：复用现有路由器，提供渠道策略和可观测健康快照。
- 验收：冷却原因和倒计时可见；策略影响后续请求；手动恢复行为明确；
  并发探测、取消与重新配置不会写回过时状态。

## P2：网关访问密钥操作

- 旧版证据：`../src/api/admin/settings.ts` 的显式读取/生成；
  `../ui/index.html` 的显露、复制及自动隐藏。
- Next 现状：只有输入、保存和清除，不能取出现有密钥配置客户端。
- 实现边界：独立认证接口、主动显露、限时隐藏和安全生成；
  此处是网关密钥，不是出站代理池。
- 验收：显式操作可读取/复制/轮换，轮换立即生效；
  普通 DTO、SSR boot payload、日志均不返回密钥。

## 已有能力与范围约束

已有渠道 schema 编辑与密钥保留、单模态 preset JSX、代理池和渠道选择、
基本模型发现、自动/手动探测、源启停删除、请求持久化、统计后端、四个 UI slot
基础渲染。上述能力不重复列为缺失。

保持 Deno + Hono JSX SSR 和 island；源配置表单由 host 生成；添加流程保持
同一模态；搜索、memory 等 Chat 功能由插件提供。签到按此前明确范围暂不搬迁。

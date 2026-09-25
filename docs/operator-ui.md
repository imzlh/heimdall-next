# Operator UI 架构与接口映射

控制台采用 Hono JSX 服务端渲染，并用 `hono/jsx/dom`
为表单、弹窗、刷新和插件槽位增加交互。
运维控制台覆盖概况、渠道、插件和设置；独立 Chat 页面位于 `/admin/chat`，可返回
`/admin`。已有聊天 API 保持兼容。所有脚本和样式随应用构建，字体使用系统字体；
运行时不依赖 CDN。

当前初始 HTML 包含完整只读内容。浏览器入口把 `#heimdall-console` 作为一个 island
挂载交互控制台，文档外壳与导航继续由服务端提供。表单和各个列表尚未拆成独立挂载的
island。 这一区分不影响关闭 JavaScript 后阅读快照，但不能把当前实现描述成逐组件
hydration。Chat 使用自己的 `#heimdall-chat` island 和独立浏览器入口，不加载
console 主包。

## 可离线阅读的设计预览

[浅色预览](previews/operator-light.html)与[深色预览](previews/operator-dark.html)
直接复用 `AdminShell`、`src/web/pages/console.tsx`、服务端 schema
字段及插件槽位组件。
每份文件按顺序展示总览、渠道、设置、插件页、添加渠道流程与完整控件目录；导航使用页内锚点。
所有数据均标注为“示例数据”，控件禁用，样式内联，字体使用系统字体，无外部脚本或资源请求。

在仓库根目录运行以下命令重新生成：

```text
deno task preview:ui
```

生成器位于 `scripts/render-ui-preview.tsx`，只读取手写 CSS 与固定 JSON 示例，
不连接运行实例、读取数据库或访问上游。页面与样式修改后应重新生成预览。 HTML
结构、类型和纯逻辑检查不能替代真实浏览器中的视觉与交互验收。已使用固定示例数据和实际浏览器包，
在 Chrome 中检查深浅主题、1440/390/320px 布局、添加渠道三步与固定底栏，以及 Chat
输入框； 该检查不连接真实渠道或发送模型请求。

独立的 [Chat 浅色预览](previews/chat-light.html)与
[Chat 深色预览](previews/chat-dark.html)复用 `ChatShell` 和 `ChatPageView`， 由
`scripts/render-chat-preview.tsx` 生成：

```text
deno task preview:chat
```

Chat 预览使用固定示例历史和内联样式，操作禁用，链接仅定位本地示例；不加载 Chat
浏览器包，也不连接真实会话。运维预览继续只展示运维控制台。

## 构建与运行边界

`main.ts` 与 `src/composition` 负责组装，`src/http` 负责 Hono 路由与 Web 入口。
`src/web/components`、`src/web/pages` 使用 `hono/jsx` 在服务端生成 HTML；
`src/web/client/main.tsx` 和 `chat-main.tsx` 分别使用 `hono/jsx/dom`
挂载各自页面的浏览器增强区域。双方只通过 `packages/admin-contracts` 的 JSON
DTO、schema 与 HTTP 端口交换数据。

`deno task prepare`
缓存服务端及内置插件入口的依赖并构建浏览器资源；`deno task dev` 准备后监听变更；
`deno task start` 准备后启动服务；`deno task serve` 使用缓存依赖和预构建资源。
`deno task build:web` 通过 `scripts/build-web.ts` 和 `scripts/web-build.ts` 调用
Deno 自带 bundler，分别构建 console、Chat 以及 manifest 声明的预设页面模块。
console 输出 `public/assets/console.js` 与 `console.css`；Chat 独立输出
`chat.js` 与 `chat.css`。不需要 Node 或 npm
构建工具。通用能力优先复用轻量成熟依赖；Chat 使用固定版本 Marked 解析 Markdown，
依赖随浏览器包本地构建，不引入 React 或其他 UI 框架。
首次准备仍需要取得依赖；缓存与资源准备齐全后，控制台静态资源不依赖互联网或 CDN。
实际模型请求、渠道探测及插件业务是否需要网络由其后端操作决定。

## 页面、布局和交互归属

运维页面位于 `/admin`，通过 `?view=overview`、`?view=channels`、`?view=settings`
选择视图。插件页使用
`?view=plugin&tab=<pluginId:contributionId>`。导航链接由宿主生成， 不占用已有
`/admin/*` 管理 API 路径。添加渠道的全部步骤都在渠道页的同一个模态中切换， 复用
console 浏览器入口。保留“基本信息 → 配置方式 → 完成配置”三步，桌面弹窗固定为 560
×
520px，窄屏按视口收缩。当前步骤使用紧凑进度文字，正文独立滚动，底部操作保持原位。

视觉延续原 Heimdall：桌面使用 224px 悬浮侧栏、22px 圆角卡片与胶囊按钮，
窄屏改为顶部导航和单列内容。浅色背景 / 卡片 / 强调色分别为 `#f5f6f7` / `#ffffff`
/ `#2264d6`；深色对应 `#0d0e12` / `#15181e` /
`#2b89ff`。手写样式按基础控件、外壳布局和卡片拆分为
`style.css`、`shell.css`、`cards.css`，SSR 与浏览器增强使用同一套主题 token。
总览依次显示实例指标、插件概况卡片、最多三条渠道摘要、插件管理卡、可折叠模型目录与最近请求；
浏览器增强后还能查看可折叠的每日用量。渠道页使用独立圆角卡片显示来源、健康和配置入口，
单卡宽度不超过 440px；配置预设仅在添加渠道的第二步选择，不在渠道页重复展示。
插件管理入口回到总览；设置页承载运行设置。当前没有列表搜索或筛选控件。
浅色、深色主题由宿主统一提供，插件继承颜色和排版。

通用图标统一使用 Lucide，定义与 SSR、浏览器渲染入口集中在
`src/web/shared/icons.tsx`。关闭、返回、刷新、渠道管理和密码显隐使用带可访问名称的图标按钮；
添加、下一步和保存等主要动作保留文字。图标随本地资源打包，不依赖图标字体或 CDN。

| 区域           | 服务端职责                                             | 浏览器 island 职责                       |
| -------------- | ------------------------------------------------------ | ---------------------------------------- |
| 文档与导航     | 标题、当前视图、可访问链接、登录表单                   | 主题切换、按目录同步插件导航             |
| 概况和渠道列表 | 输出已有的脱敏快照、空状态和错误状态                   | 刷新、探测、打开配置入口                 |
| 表单区域       | 页面显示只读配置摘要；另提供可复用的 schema 字段渲染器 | 字段状态、校验、提交、ETag 冲突处理      |
| 插件槽位       | 分配容器并输出 schema 回退内容                         | 根据宿主策略挂载交互、分发动作、清理资源 |

服务端页面不能依赖浏览器首次渲染才能显示数据。关闭 JavaScript
时仍可登录、导航和查看只读快照； 动态编辑需要
JavaScript。浏览器不得导入服务端模块，服务端也不得导入 island 模块。

## 登录和数据端口

`POST /admin/session` 接收普通表单字段 `token`。验证成功后默认跳转到 `/admin`；
Chat 登录表单提交白名单值 `returnTo=/admin/chat` 时返回 Chat。登录会设置
`heimdall_admin_session` 签名
cookie：`HttpOnly`、`SameSite=Strict`、`Path=/admin`， 有效期八小时，HTTPS 下带
`Secure`。cookie 只含过期时间、随机值和签名，不含管理员凭据。
签名密钥保存在进程内，重启后需重新登录；`POST /admin/logout` 结束会话。

服务端通过现有管理 API 读取授权快照。浏览器通过 `POST /admin/ui/request` 提交
`{ path, method, body?, headers? }`；宿主只转发允许的方法和 `/api/admin/*`
路径，内部补入 管理员 bearer，保留状态码、ETag 和请求 ID。它不代理任意
URL、上游请求、聊天或任意插件路由。 登录、登出和转发端点检查同源提交。直接调用
`/api/admin/*` 和既有 `/admin/*` 管理 API 的客户端继续使用 bearer 认证。

| UI 操作              | 现有管理 API 端口                                                            | 契约                                                                   |
| -------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 概况                 | `GET /health`、`GET /api/admin/models`、`GET /api/admin/status`              | 独立处理部分读取失败                                                   |
| 渠道、插件、预设列表 | `GET /api/admin/sources`、`GET /api/admin/plugins`、`GET /api/admin/presets` | 使用脱敏列表 DTO                                                       |
| 创建独立渠道         | `POST /api/admin/sources`                                                    | UUID v4、名称、优先级、源插件及配置；成功 `201` + ETag，重复身份 `409` |
| 修改渠道信息与启停   | `PATCH /api/admin/sources?id=...`                                            | 名称、优先级、实例启停；使用 `If-Match` 防止覆盖他人修改               |
| 删除渠道             | `DELETE /api/admin/sources?id=...`                                           | 确认后发送 `If-Match`；只移除当前实例与保存配置                        |
| 读取渠道配置         | `GET /api/admin/source-config?id=...`                                        | 保留响应 ETag，密钥仅返回配置状态                                      |
| 校验渠道配置         | `POST /api/admin/source-config/validate?id=...`                              | `{ config }`；服务端验证为最终依据                                     |
| 保存渠道配置         | `PUT /api/admin/source-config?id=...`                                        | `{ config }` 和 `If-Match`；冲突后重新读取                             |
| 预设预览与应用       | `POST /api/admin/preset-preview`、`POST /api/admin/preset-apply`             | `{ presetId, config }`；应用使用当前 ETag                              |
| 渠道探测             | `POST /api/admin/source-probe`                                               | `{ sourceId }`，显示真实结果                                           |
| 插件启停             | `POST /api/admin/plugin-state`                                               | `{ pluginId, enabled }`；受已有宿主能力约束                            |
| 运行设置             | `GET/PUT /api/admin/settings`                                                | 代理密钥、每分钟限制、探测间隔，写入保留 ETag                          |
| 最近请求与用量       | `GET /api/admin/requests`、`GET /api/admin/usage`                            | 只读记录，加载与错误状态互相独立                                       |
| 用量统计（自然日）   | `GET /api/admin/stats`、`/stats/series?days=N`、`/stats/models?date=`        | 按 `HEIMDALL_TIMEZONE` 的自然日统计，只读                              |

保存探测间隔后立即重新安排后台探测，设为 `0` 会取消当前探测。手动与自动探测共用
10
秒超时及取消逻辑；关闭请求不会把渠道误标记为故障。渠道重新配置或删除后，旧探测
结果不会覆盖当前状态；同一渠道已有更新探测时，也忽略较旧结果。

插件槽位的动作通过独立的 `POST /admin/ui/action`，而不是任意 URL 转发。其请求为
`{ contributionId, action: { id, payload }, sourceId?, theme? }`。服务端重新检查会话、
启用中的贡献、贡献级动作白名单和来源归属，并从宿主数据重建上下文；不接受浏览器传入的任意
`data`。 浏览器回调已经接入该端点，业务处理器仍须由组合根显式注册。

`GET /admin/ui/catalog` 是同源 Web 目录端口，返回
`{ contributions, schemas, sourcePluginIds, presetPages }`，使用 Web 会话认证与
`no-store`， 校验后的 JSON 最大 4 MiB。浏览器使用 HttpOnly
会话；端点也兼容现有的管理员 Bearer。
未配置管理令牌的实例可直接读取。页面刷新及保存、插件启停或卸载后的刷新会重新获取目录，
同步四类槽位和宿主的 `[data-plugin-navigation]` 区域；没有后台轮询或推送。

## 独立 Chat 页面

`/admin/chat` 提供独立会话界面；`/admin/chat?id=...`
选择已保存对话，返回链接指向 `/admin`。服务端通过既有 Chat 和模型 API
读取初始快照，输出会话列表、所选对话、
消息和模型信息。`packages/admin-contracts/chat.ts` 保存两端共享的纯 JSON DTO；
页面不接触数据库句柄，也不接收管理员令牌。未登录时不读取受保护的对话。

浏览器在 `#heimdall-chat` 挂载独立的 Hono JSX DOM island，支持新建和切换会话、
选择模型、发送文本和图片、查看流式回复、停止生成及重新生成最后一轮回复。 关闭
JavaScript 后仍可登录、通过普通链接选择对话并阅读服务端快照；交互操作需要
JavaScript。侧栏提供会话重命名与删除确认；失败保留当前内容和草稿，删除成功后选择
相邻会话，最后一个会话删除后回到空态。生成期间服务端拒绝会话修改，返回 `409`。

助手消息使用固定版本 Marked 生成 token，经宿主允许的节点模型再渲染为 JSX， SSR
与浏览器共用解析逻辑。支持标题、列表、引用、链接、表格及代码块，代码可单独复制；
原始 HTML 不执行，链接协议受限。解析和样式均在本地，不加载 CDN。

Chat 底部沿用原 Heimdall 灵动输入框：静息宽 480px，聚焦宽 720px，
宽度与文本高度使用 420ms 的 `cubic-bezier(.32,.72,0,1)` 过渡。
单行胶囊随内容长高，达到 144px 后在输入区内滚动；图片管理浮层位于上方，
不会改变输入框宽度。发送与停止按钮常驻同一个圆形槽位，以淡化、缩放切换；
模型选择放在顶栏。Enter 发送，Shift、Ctrl 或 ⌘ 加 Enter 换行，
输入法候选确认不会发送。发送失败恢复的草稿同样重新计算高度。

消息入场、复制反馈、移动侧栏及图片浮层有短过渡；系统开启减少动态效果后停用动画。
渠道添加模态也保留真实离场时间，结束或超时兜底后才卸载，返回步骤按反方向进入。
离线 Chat 预览附带等待、聚焦、多行、生成中四种静态状态，真实交互仍需浏览器验收。

Chat 复用 `POST /admin/session` 建立的 HttpOnly 会话。浏览器使用独立的
`/admin/chat/api/*` HTTP/WS 会话入口，宿主在这里注册原有 Chat
路由，并检查会话与同源 请求。写操作和 WebSocket 升级要求 `Origin`
与当前页面一致；HTTP 响应使用 `no-store`。`/admin/ui/request` 仍只转发管理
API，不承担 Chat 流式连接。 直接调用 `/api/chat/*` 的客户端保持既有认证方式。

| Chat 操作            | 浏览器端口                                   | 契约                                                 |
| -------------------- | -------------------------------------------- | ---------------------------------------------------- |
| 列出、新建会话       | `GET/POST /admin/chat/api/conversations`     | 使用服务端保存的会话列表与新建结果                   |
| 读取对话             | `GET /admin/chat/api/conversation?id=...`    | 返回会话与已保存消息                                 |
| 重命名会话           | `PATCH /admin/chat/api/conversation?id=...`  | 提交标题，生成期间 `409`                             |
| 删除会话             | `DELETE /admin/chat/api/conversation?id=...` | 原子删除会话、消息与附件，生成期间 `409`             |
| 发送、停止、重新生成 | `WS /admin/chat/api/socket`                  | `send`、`stop`、`regenerate`；增量与最终状态分开处理 |

每条消息最多附带四张 PNG、JPEG、GIF 或 WebP 图片，浏览器先校验数量、类型和大小。
图片以 `{ mediaType, dataBase64 }` 进入既有消息契约；当前单张文件上限为
1,050,000 字节。模型是否能处理图片仍取决于所选渠道的能力。
连接失败不会自动重发生成请求，客户端重新读取已保存的消息，以免生成重复回复。

Chat 内核只负责有界历史、生成、取消和通用工具编排。
`packages/contracts/tools.ts` 的 `ToolPlugin`
声明工具与执行契约，组合根传入工具注册表； 内核不内置工具名、websearch 或 memory
特例。时钟与网页搜索/抓取实现分别位于
`plugins/tool-clock`、`plugins/tool-web`，其他扩展也通过插件提供；当前没有随仓库提供的
memory
插件。插件调用共用取消信号与按运行计数的预算，搜索服务和网络策略由插件负责。

## 宿主统一 schema 表单

`packages/admin-contracts/forms.ts` 定义纯数据字段描述和校验。SSR
与浏览器共享描述，控件实现分别留在 `src/web/components` 和
`src/web/client/forms`。插件提供字段数据，不提供全局表单控件。当前页面的配置编辑只在浏览器增强后打开；
SSR 字段渲染器是可复用组件，不代表页面已经输出整套可提交的无 JavaScript
配置表单。

实际字段从 source/preset 插件的 `manifest.json.configSchema` 读取。
`src/composition/source-schemas.ts` 调用 `parseSourceConfigSchema` 校验，要求
schema 的 `id` 与插件 `id` 一致，再通过 `adminUiSchemas`
交给授权页面和浏览器配置面板。 OpenAI、Anthropic 和 NewAPI 的 manifest 均已声明
schema；`src/web/shared/source-schemas.ts` 保留内置回退，缺少受支持 schema
的未知来源不会显示误导性的通用编辑表单。 当前支持最多 128 个字段、8
层分组、每个枚举最多 128 个选项、单份 schema 最大 64 KiB。

| 字段            | 宿主表现与状态                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| `string`        | 标签、说明、占位、长度约束；支持多行、URL 和字符串映射                          |
| `secret`        | 密码输入；永不回填明文；留空保留已配置密钥；删除密钥必须是单独动作              |
| `number`        | 数值输入、范围、整数约束                                                        |
| `bool`          | 带可访问标签的开关或复选框                                                      |
| `enum`          | 由 schema 提供的有限选项                                                        |
| `group`         | 字段分组、标题和说明                                                            |
| `authorization` | 宿主解析的动作 ID，展示 idle/pending/success/error；不得把任意 URL 当授权处理器 |

既有渠道编辑先进行本地字段校验，再调用原有服务端校验与写入。按钮显示进行中状态并避免重复提交；
字段错误显示在字段旁，服务端错误保留请求
ID。版本冲突保留输入并要求读取最新版本，不能报告保存成功。 schema
支持授权字段并不表示当前后端已提供某个 OAuth 或第三方登录流程。 `authorization`
控件在没有宿主处理器时禁用；当前通用来源配置面板没有注册这类授权流程。

## 在同一个模态内添加渠道

点击“添加渠道”打开模态，先填写名称和整数优先级，再在同一个模态中选择预设或自定义。
选择预设后，插件提供的 preset JSX 直接挂载到模态内容区；选择自定义后，
模态内显示源插件选择与宿主 schema 表单。所有步骤复用同一个 dialog，
配置阶段可加宽内容区，不打开新标签或独立页面。

返回上一步保留基础信息与选择状态；离开插件配置步骤时卸载其 JSX。
基础草稿、连接配置和密钥仅保存在内存中，不进入 URL 或浏览器存储。
取消关闭会清理草稿和配置；保存失败时在模态内提示并保留当前输入，
成功创建后关闭模态、刷新渠道列表并显示通知。

`POST /api/admin/sources`（兼容 `/admin/sources`）接收
`{ id, name, priority, sourcePluginId, presetId?, config }`。`id` 必须为 UUID
v4； 接口只创建新实例，成功返回 `201`、脱敏 DTO 和 ETag，重复身份返回
`409`，不会覆盖 已有渠道。名称、优先级与源插件归属独立于 provider config
持久化，在重启、插件停启和
已有渠道配置编辑后仍然保留；优先级数值越小越先被选择。创建不使用既有编辑端点的
`If-Match` 更新流程。

自定义配置选择具有 schema 的源插件，并使用宿主 `SchemaForm`，完成本地校验后提交
创建 API。预设配置在模态中加载插件自己的 `plugins/<dir>/ui.tsx`，要求 manifest
的 `presetPage.modulePath` 与宿主 `UiPolicy.trustedModules["<presetId>:setup"]`
精确一致，并要求预设及其源插件均启用；构建脚本将入口输出到声明的本地路径。
宿主通过 SSR boot 与动态 UI 目录提供已授权模块映射。没有获准 JSX 模块时，
若预设声明了 schema，宿主在同一模态内生成预设表单；二者都不可用时显示提示，
可返回重新选择。已获准模块加载失败会保留错误提示，不执行其他模块。

预设模块接收受校验的 `PresetUiContext`，通过 `heimdall:preset-action` 提交
`{ kind: "save" | "preview", config }`，宿主负责 HTTP 请求和持久化，再通过
`heimdall:preset-feedback`
返回状态。保存创建新渠道；预览只报告配置校验结果，不回传
配置或后端响应体。管理员凭据不进入插件上下文，用户填写的提供商密钥也不会进入基础草稿。

ChatHub 预设在同一模态内提供 Microsoft 授权流程：准备登录、主动打开授权链接、
粘贴回调地址、校验账号、保存渠道。它经 `POST /admin/ui/request` 固定转发到
`POST /api/admin/plugins/chathub/auth`；PKCE verifier
留在服务端，授权状态单次使用且 15 分钟过期。新授权得到的 provider token
仅留在预设内存，保存时交给宿主；离开配置步
清理输入并取消请求。预设选择本身不会打开新页面。未批准 JSX 的实例仍可选择源的
自定义 schema 表单。

## 插件 UI 四个槽位

槽位名称只有以下四个；渠道状态使用规范名
`source.status`。宿主决定容器位置、标题、留白和响应式布局，
插件只能填充获分配的内容区。表内尺寸是布局约束，实际宽度随容器缩放。

| 槽位               | 位置与尺寸                                                                  | 允许内容                               |
| ------------------ | --------------------------------------------------------------------------- | -------------------------------------- |
| `dashboard.widget` | 概况卡片网格的一格，最小宽 240px、间距 16px、内边距 22px，窄屏一列          | 少量指标、状态、说明和动作             |
| `source.status`    | 匹配来源插件的渠道卡片内部，全卡片宽；最大高 160px、内边距 14px，超出可滚动 | 该来源的授权、额度、健康或同步状态     |
| `settings.section` | 设置页一段，最大宽 820px、内边距 22px                                       | 配置说明、局部状态和宿主动作           |
| `nav.tab`          | 宿主导航的一行和对应全宽页面内容区；导航内边距为上下 10px、左右 13px        | 标签和专属页面内容，不直接改写宿主导航 |

`UiContribution` 包含 `pluginId`、`id`、`slot`、`title`、可选顺序及
`schema.blocks`； `source.status` 还要求 `sourcePluginId`。贡献项由
`${pluginId}:${id}` 唯一标识。 schema 块支持
metric、text、badge、link、action；链接仅导航控制台，动作只包含 ID 和 JSON
payload。 每个贡献都提供可用的 schema 回退，即使它还声明可执行渲染器。

`metric.valueFrom`、`text.textFrom` 和 `badge.labelFrom` 可声明从当前
`context.data` 读取的字段路径，例如 `"valueFrom": ["source", "modelCount"]`。
路径只允许逐层读取 JSON 自有属性，不执行表达式，不读取原型或 getter；缺失字段、
非标量值和超出长度限制的文本继续使用块中必填的静态回退值。SSR 与客户端使用同一
解析器，刷新状态时同步更新数值，不需要插件脚本。

默认每次注册最多 32 个贡献，每个贡献最多 16 个块；标题最多 80 字符、文本最多
1024 字符， JSON 上限 16 KiB、深度上限 6。宿主按顺序与贡献 ID
稳定排序，来源状态按来源插件匹配。

## 三种渲染模式与宿主动作

| 模式           | 加载方式                                                | 权限边界                                                             |
| -------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| schema（默认） | 宿主 SSR/JSX 控件渲染纯数据                             | 不执行插件脚本；未授权动作保持不可操作                               |
| trusted        | 本地模块导出 `mount(el, ctx)`，可返回同步或异步清理函数 | 宿主按贡献 ID 精确允许本地模块路径；可信代码拥有所在页面的浏览器权限 |
| sandbox        | 本地 HTML 在 `sandbox="allow-scripts"` iframe 中运行    | 不添加 `allow-same-origin`，通过受校验的消息和宿主动作通信           |

`UiPolicy` 由宿主创建，分别配置 `trustedModules`、`sandboxDocuments` 和
`allowedActions`。 插件 manifest 不能给自己授权。可执行资源路径必须是宿主允许的
`/admin/assets/plugins/...js` 或 `...html`；四类贡献槽位未匹配策略时回退到
schema。

标准 `serve` 入口为四类贡献槽位保留 schema 默认模式；组合根另行加入已审核的
`heimdall.preset.newapi:setup → /admin/assets/plugins/newapi-setup.js` 与
`heimdall.preset.chathub:setup → /admin/assets/plugins/chathub-setup.js`
预设页面授权。运维可通过 `HEIMDALL_UI_POLICY_PATH` 指向宿主管理的 JSON
文件，声明 `trustedModules`、`sandboxDocuments` 与
`allowedActions`；同名策略项覆盖内置映射。 策略文件最大 16
KiB，非法策略会拒绝启动；默认没有 iframe 或四槽位业务动作白名单。
内置静态服务公开 console、Chat 的 JS/CSS，以及策略允许的插件 JS/HTML
路径，并验证插件文件的实际路径仍位于资源根目录。默认资源目录为 `public/assets`，
可用 `HEIMDALL_ADMIN_ASSETS` 覆盖；仅将文件放入目录不会公开它。

例如宿主可为已有贡献声明以下策略，文件分别放在资源根目录的 `plugins/newapi.js`
与 `plugins/newapi.html`。相应贡献仍需在 manifest 的 `render`
中声明一致的模式和路径；策略文件本身不创建贡献。

```json
{
    "trustedModules": {
        "heimdall.preset.newapi:connection-guide": "/admin/assets/plugins/newapi.js"
    },
    "sandboxDocuments": {
        "heimdall.preset.newapi:guide": "/admin/assets/plugins/newapi.html"
    },
    "allowedActions": {
        "heimdall.preset.newapi:settings-note": ["refresh-status"]
    }
}
```

四类贡献槽位的业务动作需要宿主通过
`createServer({ adminUiPolicy, adminUiActions })` 或 `serve({ adminUiActions })`
注册处理器；默认可执行入口不提供插件专属业务处理器。 `adminUiActions` 按动作 ID
查找处理器，处理器负责验证自己的 payload。 UI
提交到服务端后仍会再次校验；只有动作白名单而没有处理器时，端点返回不可用。

`UiContext` 是
JSON：`{ locale: "zh", theme, sourceId?, sourcePluginId?, data }`。 其中 `data`
由宿主筛选并脱敏，不含 cookie、管理员 token、数据库句柄或应用全局状态。
总览、设置与导航槽位只收到服务状态及渠道、模型、插件数量的汇总；渠道槽位的
`data.source` 只包含当前渠道的 `enabled`、`state`、`priority`、`modelCount`、
`capabilityCount` 和
`probeStatus`。渠道配置、密钥、原始探测错误和其他渠道数据不会 进入上下文。内置
OpenAI、Anthropic 和 ChatHub 状态部件通过这些字段显示真实状态；
尚无后端数据的额度和热上下文不会显示为虚构指标。

动作端口仍重新构造身份上下文并提供空 `data`，处理器需要从宿主端口读取最新状态，
不会信任浏览器回传的展示值。动作使用
`{ id, payload }`，宿主先检查该贡献获准的动作 ID，再验证具体
payload，最后调用既有端口。 注册渲染器不会自动注册业务动作，也不会开放任意 fetch
代理。

可信模块通过挂载元素上的 `heimdall:ui-action` 事件请求动作。iframe 消息使用
`{ protocol: "heimdall.ui", version: 1, instance, kind, ... }`，宿主校验 frame
的 Window 身份、 opaque origin 和每实例随机值；仅处理
ready、resize、action。iframe 在 10 秒内未 ready 时保留回退；高度限制在
96–480px。 卸载时移除监听器、iframe
和已挂载资源；异步挂载晚于卸载完成时也执行清理。 失败保留原有 schema
内容，不阻断其他卡片和表单。

## 可运行的 schema UI 注册示例

以下是要合并到
[plugins/newapi-preset/manifest.json](../plugins/newapi-preset/manifest.json) 的
JSON 片段。保留现有版本、种类、信任级别、权限和配置 schema
等字段，不能用片段替换完整 manifest。 示例使用已经存在的 NewAPI
预设插件，不需要创建新的运行模块，也不执行浏览器插件脚本。

```json
{
    "id": "heimdall.preset.newapi",
    "ui": [
        {
            "pluginId": "heimdall.preset.newapi",
            "id": "connection-guide",
            "slot": "dashboard.widget",
            "title": "NewAPI 配置入口",
            "order": 10,
            "schema": {
                "blocks": [
                    {
                        "kind": "text",
                        "text": "使用服务地址和 API 密钥配置已有渠道。"
                    },
                    {
                        "kind": "link",
                        "label": "打开渠道页",
                        "href": "/admin?view=channels"
                    }
                ]
            }
        },
        {
            "pluginId": "heimdall.preset.newapi",
            "id": "source-note",
            "slot": "source.status",
            "sourcePluginId": "heimdall.source.openai-compatible",
            "title": "NewAPI 预设说明",
            "schema": {
                "blocks": [
                    {
                        "kind": "badge",
                        "label": "OpenAI 兼容来源",
                        "tone": "neutral"
                    },
                    {
                        "kind": "text",
                        "text": "可在渠道配置中选择 NewAPI 预设；此说明不代表实时健康结果。"
                    }
                ]
            }
        },
        {
            "pluginId": "heimdall.preset.newapi",
            "id": "settings-note",
            "slot": "settings.section",
            "title": "请求与探测",
            "schema": {
                "blocks": [
                    {
                        "kind": "text",
                        "text": "实例级请求限制和探测间隔由上方运行设置统一管理。"
                    }
                ]
            }
        },
        {
            "pluginId": "heimdall.preset.newapi",
            "id": "guide",
            "slot": "nav.tab",
            "title": "NewAPI 指南",
            "schema": {
                "blocks": [
                    {
                        "kind": "text",
                        "text": "先打开渠道页，再选择要配置的渠道及 NewAPI 预设。"
                    },
                    {
                        "kind": "link",
                        "label": "进入渠道配置",
                        "href": "/admin?view=channels"
                    }
                ]
            }
        }
    ]
}
```

在 `heimdall-next` 运行 `deno task start`，登录 `/admin`
后即可在概况和设置页看到卡片。 已存在的 OpenAI
兼容渠道内会显示来源说明；导航中的指南地址为
`/admin?view=plugin&tab=heimdall.preset.newapi%3Aguide`。没有对应渠道时，不生成来源状态容器。

注册流程由 `src/composition/ui-contributions.ts` 读取
`plugins/*/manifest.json`，调用 `parseManifestUi` 验证贡献归属。 `serve` 将
`loadUiContributions` 与 `loadSourceSchemas` 作为 provider 传入宿主； 每次已授权
SSR 或目录读取都会重新读取有界 JSON，不导入插件运行代码。
页面只展示当前运行目录中处于启用状态的插件贡献；启用令牌保护时，未登录不输出贡献数据。

已加载插件的 `ui` 与 `configSchema` 声明修改后，刷新即可生效。
禁用或卸载插件后，目录同步会移除相应槽位与导航，并运行已有挂载清理。 插件
`mod.ts`
的新增或运行逻辑修改仍需要重启；宿主信任策略在启动时读取，修改也需重启。
可信模块仍遵循浏览器标准 ESM 缓存，声明刷新不保证重新执行同一路径的模块。

内置来源支持已有启停操作；PluginHost 提供安装、启停、卸载和调用端口，
但默认组合未注入 `runtimeFactory` 或 Worker 运行适配器，也没有安装上传路由。
动态 JSON 目录不等于任意第三方运行插件已经能在线安装。

纯数据 schema 可直接显示。`render.kind`
只是在声明期选择候选渲染器，不会自动启用可信脚本或 iframe。
这些模式仍需宿主显式注册策略与资源；不要通过把 `trust` 改成 `trusted`
来尝试授予页面执行权限。

## 验证范围

`deno task verify` 覆盖类型检查、纯逻辑测试、SSR
输出检查、架构边界和浏览器打包。 SSR 检查关注完整只读内容、凭据不进入
HTML、同源登录/桥接行为、稳定 API 兼容和槽位回退。
纯逻辑检查关注字段校验、脱敏、ETag 处理、槽位策略和消息校验。
这些检查不等同于真实浏览器中的布局或交互验收；视觉和实际 DOM
交互仍需在浏览器环境单独验证。

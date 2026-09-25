# HIP v1 内部协议

## 定位

HIP（Heimdall Internal Protocol）是内核、协议插件、请求钩子和 Source
插件之间的私有语义协议。v1 的权威 TypeScript 定义是
`packages/hip/mod.ts`；`@heimdall/contracts` 只重导出这套值类型供插件使用。
校验、reducer、持久化和传输实现可以由 host package 提供，但必须消费同一套
`OperationRequest` 和有序 `StreamFrame`。插件边界不得再定义平行的
`Canonical*`、`Internal*` 或供应商 DTO 作为内核协议。

HIP v1 当前定义的是 `generation` 操作族，不声称一个生成载荷可以表达任意
API。未来的 embeddings、媒体生成、文件等能力应增加独立且版本化的
`OperationPayload`
类型，共用帧、错误、用量和扩展规则；不能把它们伪装成消息生成。

HIP 不复制 OpenAI 或 Anthropic 的对象结构。它由四层组成：

1. 小而稳定的生成请求语义；
2. 可表达多模态与工具交互的消息/内容部件；
3. 可持久化、重放和流式转发的追加事件；
4. 保留未知语义的命名空间扩展。

这比追求一个“包含所有供应商字段”的巨大对象更可靠。通用语义进入稳定核心，供应商独有且尚未标准化的数据保持原样，转换损失必须显式记录。

## 数据约束

所有跨隔离边界或持久化的 HIP 值必须是 JSON
安全值：`null`、布尔、有限数字、字符串、数组或仅含这些值的对象。禁止
`undefined`、`bigint`、函数、循环引用以及隐式类实例。

ID 是不透明、非空字符串；消费者不能从 ID 前缀推断类型。时间戳使用带时区的 RFC
3339 字符串，生产者应输出 UTC。金额使用十进制字符串。

大对象不应直接塞入事件。`BlobRef` 可通过 `uri` 引用内容，或在受大小限制时使用
`dataBase64`；`mediaType` 必填，已知时应提供字节数和
SHA-256。引用的授权与生命周期由内核管理，不由 URI 本身暗示。

## 请求模型

`OperationRequest` 是所有 HIP 操作的统一 envelope。v1 的标准消息生成载荷名为
`GenerationRequest`，位于 `request.payload`；`request.operation` 是稳定的 HIP
命名空间标识（例如 `generation.create`）。其他能力可通过版本化的自定义载荷加入，
但不能把供应商线协议对象直接当作 envelope。

`GenerationRequest` 的字段语义如下：

| 字段                   | 语义                                               |
| ---------------------- | -------------------------------------------------- |
| `messages`             | 输入消息；每条消息由稳定 ID、角色和内容部件组成    |
| `model`                | 用户请求的逻辑模型名；允许路由钩子解析或改写       |
| `instructions`         | 不依赖供应商角色命名的顶层指令                     |
| `tools` / `toolChoice` | 工具 schema、执行位置和选择策略                    |
| `responseFormat`       | 文本、JSON 或 JSON Schema 约束                     |
| `sampling`             | 已标准化的数值采样参数；名称须由 HIP 定义          |
| `stream`               | 客户端是否希望流式传输，不限制 Source 内部执行方式 |
| `metadata`             | 用户或系统的可查询元数据                           |
| `extensions`           | 无通用表示的命名空间数据，包括原始入站字段         |

客户端线协议的路由名（例如 `chat.completion`、`responses`）属于插件自己的
`ParsedRequest` 或扩展数据，不应覆盖 HIP 的 `operation`。插件完成解析后必须把
标准语义写入 `OperationRequest`，无法表示的原始字段放入命名空间扩展。

取消也是独立的控制请求：`CancelRequest` 至少携带 HIP `version` 和目标
`requestId`，可带 `streamId`
与原因。控制请求只表达意图；执行结果仍必须通过流事件 确认。

消息的 `parentId`
形成有向无环关系，用于重试分支、多候选回复和工具循环。普通线性会话可不设置它。产生或持久化消息时必须拒绝自引用、循环和不存在的父节点。
父节点可以位于 `run.started.request.messages`
输入快照中，也可以是本流较早产生的输出消息。

## 内容部件

`Message.parts` 是有序列表。每个部件有稳定
`id`、类型、完成状态和可选扩展。作为输出事件时，`message.started.message.parts`
必须为空；每个输出部件均由单独的 `part.started`
引入。对于可追加字段，`part.started` 携带空初值，内容通过 delta
产生。这样逐帧适配器和最终状态物化器能观察到相同语义。输入消息不受此限制。

| 类型                                     | 用途及关键规则                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `text`                                   | 用户可见文本；delta 只追加 UTF-8 字符串                                              |
| `reasoning`                              | 推理文本，生产者应明确标记 `public`、`private` 或 `redacted`，签名按不透明字符串保存 |
| `image` / `audio` / `video` / `document` | 通过 `BlobRef` 表示媒体，协议插件负责线协议编码                                      |
| `json`                                   | 完整 JSON 值或尚未完整的 JSON 文本；未完成前不得强制解析                             |
| `tool_call`                              | 调用 ID、名称、原始参数文本及可选已解析参数                                          |
| `tool_result`                            | 与调用 ID 关联，可携带 JSON、嵌套内容部件或结构化 `CanonicalError`                   |
| `refusal`                                | 与普通文本分开保存的拒绝内容                                                         |
| `citation`                               | 引用标签、URL 和摘录，不假定特定供应商格式                                           |
| `custom`                                 | 需要参与内容顺序但尚无通用类型的值                                                   |

工具参数的 `argumentsText` 是权威原始表示。流式过程中残缺 JSON
是合法状态；只有完整且验证成功后才填充 `arguments`。适配器不得通过重新序列化
JSON 丢失上游原始参数文本。

## 帧与事件

每个输出事件由 `StreamFrame` 包裹：

| 字段          | 规则                                 |
| ------------- | ------------------------------------ |
| `version`     | v1 固定为数字 `1`                    |
| `streamId`    | 一条可重放事件流的标识，整条流不变   |
| `requestId`   | 发起请求的标识，整条流不变           |
| `seq`         | 从 `1` 开始逐一递增的安全整数        |
| `eventId`     | 事件的稳定幂等键，在流内唯一         |
| `timestamp`   | 事件发生时间，不用于决定顺序         |
| `event`       | 带 `kind` 判别字段的事件内容         |
| `causationId` | 可选，指向引发本事件的已有 `eventId` |
| `extensions`  | 帧级传输或供应商信息                 |

事件分为以下几组（均由 `StreamEvent` 判别联合覆盖）：

- 运行：`run.started`、`run.completed`、`run.error`、`run.cancel.requested`、`run.cancelled`；
- 消息：`message.started`、`message.completed`；
- 内容：`part.started`、`part.delta`、`part.completed`；
- 工具：`tool.call`、`tool.result`，用于上游一次性给出完整工具事件；
- 计量与恢复：`usage`、`checkpoint`。

`run.error` 携带 `CanonicalError`，其中稳定的 `code` 和可选的重试、状态、供应商
编码、结构化详情及原因链由内核消费；适配器不得把供应商错误对象直接放进事件。
工具执行失败使用 `tool_result.error`（并可设置 `isError`），不应把唯一的错误语义
编码成供应商专用文本。

`part.*` 用于任何需要逐步构造的部件。`tool.call` 和 `tool.result`
是完整事件的简写语义，消费者物化时分别追加完成的 `tool_call` 或 `tool_result`
部件；生产者不得对同一次调用同时发出完整简写和等价的 `part.*` 序列。

## 规范事件顺序

一条正常输出流遵循以下状态机：

```text
run.started
  -> (message/part/tool lifecycle | usage | checkpoint | cancel.requested)*
  -> run.completed | run.error | run.cancelled

message.started -> (part lifecycle | tool.call | tool.result)* -> message.completed
part.started -> part.delta* -> part.completed
```

多条消息和部件可以交错推进；`seq`
给所有事件一个确定的总顺序。错误和取消可以中断尚未完成的消息或部件。正常
`run.completed`
要求所有已开始的消息和部件先完成；没有输出消息的空结果也是合法的。

具体不变量如下：

1. 第一帧必须是 `run.started`，其请求是本次执行采用的最终 HIP 请求快照。
2. `(streamId, requestId)` 在流中固定，`seq` 无空洞且严格递增。
3. 重复投递相同 `eventId` 是幂等的；同一 `eventId` 若内容不同，属于协议错误。
4. `messageId` 在流内唯一；`partId`
   在所属消息内唯一。引用消息或部件的事件只能出现在其 started 事件之后。
5. delta 只能追加，不能替换、截断或回写已提交内容。已完成部件和消息不能再次产生
   delta。
6. 每条流只能有一个终态：`run.completed`、`run.error` 或
   `run.cancelled`。终态后不得再发业务事件。
7. `usage`
   是截至当前时刻的完整快照，而非增量；后一个快照替换前一个快照。字段必须是非负数，`totalTokens`
   若提供应与插件声明的计量语义一致。
8. `CancelRequest` 或 `run.cancel.requested` 只记录取消意图。只有执行器发出
   `run.cancelled` 才表示实际停止；执行可能在两者之间正常完成或报错。取消确认
   仍是唯一终态之一，不能以 `run.error` 冒充已确认的取消。
9. `checkpoint.stateHash` 对应应用当前帧后的规范化状态。v1 使用
   `sha256:<64 位小写十六进制>`；输入是按 RFC 8785 规范化并以 UTF-8
   编码的状态投影，包含
   `streamId`、`requestId`、`seq`、`status`、`messages`、`usage`、`error` 和
   `finishReason`，不包含 `seenEventIds`。快照可另行存储，hash
   用于检测错误恢复或篡改。
10. 状态物化是纯函数：应用一帧返回新状态，不修改以前的状态或事件。

当前 `applyFrame` 负责 ID 去重、连续序号、引用存在性和不可变物化；SQLite
负责检测同一 `eventId` 对应不同内容的冲突。运行首帧、唯一终态、DAG
无环、完成后无事件等跨帧约束还应由内核流验证器与 SQLite
写入事务共同执行；插件不能把 reducer 尚未检查当作协议允许。

## delta 与物化

v1 的通用 reducer 对 `text`、`reasoning`、`refusal`、`tool_call.argumentsText`
和 `json.text` 应用字符串追加。v1 尚未规定 JSON 对象或 `BlobRef` delta
的可移植合并算法，生产者不得在这些已知部件上发出非字符串 delta。`part.completed`
只确认此前累积的部件完成，不能替换内容；其可选 `value`
仅供声明理解它的扩展适配器使用，通用 reducer 不物化它。媒体应在 `part.started`
中提供完整 `BlobRef`，复杂增量数据应等待后续带明确合并语义的事件版本。

流式与非流式不是两套模型。非流式协议适配器消费完整帧序列并物化最终状态；流式适配器逐帧转换。相同事件序列在两种路径中必须得到语义等价的消息、终态和用量。

## 扩展与无损转换

`extensions` 是兼容机制，不是绕过核心字段的捷径：

- `raw` 是对象局部保留原始线协议值的保留键；其他 key 使用插件 ID
  或协议名命名空间，例如 `openai`、`anthropic` 或 `heimdall.protocol.openai`；
- 已有 HIP 字段能表达的语义必须写入标准字段；原始值可同时保留以支持精确回写；
- OpenAI 入站中未映射的 JSON 字段保存在 `OperationRequest.extensions.raw`；
- 转换无法表示某项语义时，适配器在自己的扩展中记录原值和损失原因，不能静默删除；
- 扩展必须遵守 JSON、大小、密钥和隐私限制，内核将其视为不可信数据；
- 不理解某扩展的中间插件必须逐值保留；只有该命名空间所有者或显式安全策略可以修改、删除它，并应留下审计记录；
- 需要保持内容顺序或显示位置的数据使用 `CustomPart`，仅供审计的数据使用
  `extensions`。

协议插件不保证跨不同供应商后再逐字节还原原请求，但必须保证 HIP
已覆盖的语义不丢失，并保留其声明支持的供应商扩展。

## 错误、用量和隐私

`CanonicalError` 保留稳定
`code`、可读消息、是否可重试、HTTP/供应商状态、结构化详情和原因链。Source
插件先转换供应商错误，协议插件再转换为客户端线协议；内核不按供应商错误码分支。

`Usage` 可独立记录输入、输出、推理、缓存输入和总
token，以及十进制金额和币种。未知或供应商不提供的值应省略，不能填 `0`
冒充已知值。

HIP
事件可能含提示词、模型输出和个人数据。事件落库、日志和插件访问必须分别授权。凭据、Authorization
头、Cookie 和上游密钥不得写入 `raw`、`metadata`、错误详情或扩展；协议插件在构造
HIP 前负责剥离，内核在持久化前再执行统一脱敏和大小检查。

`reasoning.visibility` 是披露策略：`private` 不得发送给客户端，`redacted`
只能发送占位或供应商允许公开的摘要；旧数据省略该字段时，跨边界消费者必须按
`private` 处理，不能把缺省值当作公开许可；新生产者必须显式写入策略。`signature`
是不透明完整性数据，只有目标协议明确支持且策略允许时才能转发。协议插件不得因为客户端请求了调试字段就绕过该规则。

## 版本与兼容

HIP 版本与插件 API 版本分别演进。v1
内允许增加可选字段和新的命名空间扩展。新增事件
kind、内容类型、改变字段含义或收紧既有合法值都需要能力协商；无法保证旧消费者安全时必须提升
HIP 主版本。

持久化帧永不就地改写。读取旧版本时使用显式升级适配器生成新视图，原始事件仍保留。隔离插件
RPC 握手必须协商双方共同支持的 HIP 和插件 API
版本；没有共同版本时拒绝激活，而不是尝试宽松解析。

## OpenAI 映射原则

首期 OpenAI 协议插件同时支持 Chat Completions 和 Responses，但两者进入同一 HIP：

- Chat `messages` 与 Responses `input` 都规范化为 `Message.parts`；
- `developer`、工具消息、图像输入和多段内容保留角色及顺序；
- Chat `tool_calls[].function.arguments` 与 Responses function call 参数先保存为
  `argumentsText`；
- Chat chunk 和 Responses typed SSE 事件都转换为相同的 `part.delta` 等事件；
- `finish_reason` 转为消息或运行完成原因，原始枚举保留在 OpenAI 扩展；
- token 细分映射到 `Usage`，无法通用化的明细保留在扩展；
- 两个出站端点分别生成各自原生 JSON/SSE 形状，不能用 Chat Completions 对象冒充
  Responses 对象。

OpenAI 协议插件不访问上游网络。OpenAI Source
插件执行反向映射和网络调用，因此客户端使用 OpenAI 协议并不限制实际上游供应商。

# 本地工作区工具

`heimdall.tool.workspace` 为 Heimdall Chat 提供本地文件工具。复用现有
`ToolPluginFactory`、目录自动发现、全局启停和会话工具开关，无需额外注册代码。
文件位于 **Heimdall 服务所在机器**，不是浏览器所在机器。

## 配置

在管理页面打开 **插件能力 → 本地工作区 → 配置**：

1. 填写服务器上已经存在的目录绝对路径，如 `D:/projects/my-project` 或
   `/srv/projects/my-project`。
2. 按需启用「只读模式」，仅提供浏览、搜索和读取。
3. 保存。配置持久化到现有存储，对后续 Chat 请求生效，无需重启。

本插件不读取环境变量。未设置路径或保存空路径时，插件仍在目录中可见，但不向模型
提供文件工具。保存时验证目录与配置版本；无效目录或版本冲突不会覆盖已有配置。
已经开始的 Chat 请求继续使用开始时的配置快照，下一次请求使用新配置。

也可在管理页停用整个插件，或通过 Chat 的工具开关在单个会话中停用。这些工具由
Chat 的工具循环执行，公开 OpenAI/Anthropic 协议转发不会自动执行本地工具。

## 工具

所有路径都相对于配置的工作区，目录默认 `.`。成功结果是 JSON，失败返回
`isError: true` 和可供模型修正调用的错误信息。

| 工具                  | 参数                                                                | 行为                                                                             |
| --------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `workspace_list`      | `path?`                                                             | 列出目录的直接子项及类型；结果过多时标记 `truncated`                             |
| `workspace_read`      | `path`, `offset?`, `limit?`                                         | 读取 UTF-8 原文片段、完整文件的 SHA-256 `revision`、`nextOffset` 与 `totalChars` |
| `workspace_search`    | `query`, `path?`, `caseSensitive?`, `includeHidden?`, `maxResults?` | 递归查找字面文本，返回路径、从 1 开始的行列号和片段                              |
| `workspace_write`     | `path`, `content`, `expectedRevision?`                              | 创建文件及必要的父目录；覆盖已有文件必须提供当前 revision                        |
| `workspace_edit`      | `path`, `oldText`, `newText`, `expectedRevision`, `replaceAll?`     | 精确替换；默认要求唯一匹配，重复匹配需显式启用 `replaceAll`                      |
| `workspace_patch`     | `path`, `patch`, `expectedRevision`                                 | 应用单个现有文件的 unified diff，返回新 revision                                 |
| `workspace_find`      | `pattern`, `path?`, `includeHidden?`, `maxResults?`                 | 按 glob 查找文件，如 `**/*.ts`、`src/*.{ts,tsx}`                                 |
| `workspace_read_many` | `paths`, `offset?`, `limit?`                                        | 一次读取最多 10 个文件，各自返回 revision、分页信息或错误                        |
| `workspace_stat`      | `path`                                                              | 返回文件/目录类型、字节大小、修改时间；文本文件附 revision                       |
| `workspace_mkdir`     | `path`                                                              | 创建目录及缺失的父目录，已存在目录返回 `created: false`                          |
| `workspace_move`      | `path`, `destination`, `expectedRevision`                           | 移动或重命名单个文本文件；不覆盖目标，目标父目录必须存在                         |
| `workspace_remove`    | `path`, `expectedRevision`                                          | 按 revision 删除单个文本文件，不支持目录或递归删除                               |

先 `workspace_read` 获取 revision，再把它作为 `expectedRevision` 交给编辑工具。
读取后文件发生变化会导致编辑失败，应重新读取并调整修改。成功写入和编辑也返回新
revision。未提供 revision 的 `workspace_write` 只允许创建新文件。

批量读取默认每文件 1,200 字符，可设置到 4,000；总结果仍有上限，各文件按自己的
`nextOffset` 续读。单个文件失败不会丢弃其他文件的结果。 glob 查找复用
`node:path.posix.matchesGlob`；`includeHidden` 仅允许遍历隐藏项，
匹配隐藏路径仍需显式模式，例如 `.github/**/*.yml`。 支持
`*`、`**`、`?`、字符类和普通备选模式，最多 8 对花括号、8 个逗号； 拒绝范围展开和
extglob，避免短模式触发大量组合展开。

移动采用不覆盖目标的创建式复制，复核源版本后再删除源文件，不是跨文件的原子操作。
删除仅在明确需要删除文件时使用；移动和删除同样受路径、大小、只读与版本检查约束。
只读模式保留浏览、搜索、glob 查找、单个/批量读取及文件信息工具。

`offset` 是从 0 开始的 UTF-16 字符偏移，`limit` 默认且最多为 12,000。 按返回的
`nextOffset` 继续读取即可，包括没有换行的长行。分页不拆开 Unicode 字符，
`limit: 1` 遇到 emoji 等代理对时可返回两个 UTF-16 单元。结果为保留 JSON 完整性
可能提前截断，此时 `truncated` 为 `true`。分页期间也应比较 revision，避免拼接
不同版本的文件。

patch 示例（`path` 单独指定，diff 头不决定磁盘路径）：

```diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-export const enabled = false;
+export const enabled = true;
```

patch 使用 `diff@8.0.2` 的 `parsePatch`/`applyPatch`，`fuzzFactor: 0`：上下文和
删除行必须匹配，允许完全匹配的 hunk 随行号偏移。拒绝多文件 patch、重命名、创建、
删除及二进制 patch；创建请使用 `workspace_write`。支持 LF/CRLF 与无末尾换行。
带显式 EOF marker 的末尾 hunk 必须在声明位置匹配文件结尾，不做偏移定位；未声明
EOF marker 时沿用 jsdiff 保留原末尾换行状态的行为。
文本替换保持原文，不做空白归一化。

## 范围与限制

- 文件上限 1 MiB，只支持有效 UTF-8 文本，拒绝含 NUL 的二进制数据。
- 工具调用的整个 JSON 参数上限 32,768 字符，与 Chat 当前契约一致。大文件适合
  小范围 edit/patch；插件结果控制在 18,000 字符内，低于宿主的截断阈值。
- 每轮 Chat 运行最多 24 次工作区操作，仍受宿主每次模型回复 4 次工具调用、 共 6
  轮模型回复限制。
- 搜索默认区分大小写、跳过隐藏项；即使 `includeHidden: true` 也跳过
  `.git`、`.deno`、`node_modules`、`dist`、`coverage`。每行返回首个匹配，
  默认最多 50 条、上限 100 条。遍历最多 2,000 个目录项、500 次文件读取尝试、 20
  层目录；累计读取约 4 Mi 字符后停止，失败读取保守地按 1 Mi 计入扫描预算。
  读取失败、二进制和超限文件计入 `skippedFiles`，达到遍历/结果上限会标记
  `truncated`；大项目应缩小 `path`。
- 目录读取最多 1,000 项，还受返回文本大小限制，超出会标记 `truncated`。
- 拒绝绝对路径、`..`、Windows 驱动器/UNC/ADS 路径、符号链接，以及可检测到的
  多硬链接文件。文件写入在同一插件实例内串行执行；覆盖通过同目录临时文件替换，
  并在替换前再次核对 revision。取消或失败时清理自己创建的临时文件。
- 这是经过审核的可信目录插件，继承服务进程权限；路径检查不是操作系统沙箱，
  revision 也不是对外部进程的原子 compare-and-swap。不支持在对抗性进程可任意
  替换目录的环境中充当安全隔离边界。替换保留 POSIX 权限位，但不保证保留 ACL、
  扩展属性或其他文件元数据。

文件 I/O 使用 Deno 原生 API，路径处理复用 `node:path`，unified diff 复用
[jsdiff](https://github.com/kpdecker/jsdiff)。固定版本通过 `deno task prepare`
预缓存，生产 `serve` 继续使用离线缓存。这类工具不能作为现有隔离 JSON 包上传：
隔离 Worker 保持无文件系统权限。

验证命令：

```text
deno test --node-modules-dir=none --unstable-kv --unstable-worker-options -A tests/plugins/tool-workspace.test.ts tests/plugins/workspace-io.test.ts tests/plugins/workspace-management.test.ts tests/plugins/workspace-patch.test.ts tests/plugins/workspace-query.test.ts tests/plugins/workspace-workflow.test.ts tests/chat/workspace-composition.test.ts tests/tool-configuration.test.ts tests/tool-configuration-runtime.test.ts tests/web/plugin-config.test.tsx tests/web/tool-config-api.test.ts
```

管理页面的独立 Chrome 验收（内存存储和临时目录）：

```text
deno task build:web
deno run --node-modules-dir=none --unstable-kv --unstable-worker-options -A scripts/browser-workspace-config.ts
```

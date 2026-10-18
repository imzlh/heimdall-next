# Heimdall Desktop

桌面入口使用 Deno 原生 `deno desktop`，由 `Deno.BrowserWindow` 管理窗口， 可选用
`Deno.Tray` 启用系统托盘。应用复用服务端的 HTTP、插件、Chat
和持久化运行时，浏览器界面通过本机回环地址访问它。

## 启动与开发

开发机当前使用 Deno 2.9.7。`deno desktop` 仍为实验功能；先用
`deno desktop --help` 确认当前可执行文件包含原生桌面命令。

```text
deno task desktop
```

该任务准备依赖和浏览器资源，然后调用原生桌面命令构建并启动本地应用。已准备资源时可运行
`deno task desktop:run`。本地运行产物位于
`dist/desktop/local-<os>-<arch>-<backend>/`。首次运行时 Deno
会下载自身匹配的桌面运行时与后端，后续使用 Deno 缓存。各平台默认使用系统
WebView， Windows 使用 WebView2。

Deno 2.9.7 与 2.9.6 使用相同的 laufey 0.7.0 后端。该版 Windows WebView2
在没有消息循环的线程上创建托盘窗口，导致图标出现但真实左右键无法正常处理。
因此默认关闭托盘；关闭主窗口会退出应用并停止网关。保留 `--tray` 供显式启用，
`--no-tray` 可显式关闭。窗口边框和任务栏图标仍需真实 Windows 交互验收。

```text
deno task desktop:dev
```

开发任务同时启动浏览器资源构建监听和 `deno desktop --hmr`。Deno 负责热更新、页面
资源刷新以及无法热替换时的进程重启。新增后端插件后重新启动任务，使模块进入桌面资源图。

可显式选择后端，例如测试官方 CEF：

```text
deno task desktop:run --backend cef
deno task desktop:dev --backend cef
```

CEF 额外下载和打包 Chromium 运行文件，体积明显大于系统 WebView 后端。

## 构建与分发

```text
deno task desktop:build
```

构建任务先生成浏览器资源，再调用 `deno desktop --output`。产物与当前构建机器的
操作系统和架构一致。Windows x86_64 默认生成：

```text
dist/desktop/windows-x86_64/
  Heimdall/
    Heimdall.exe
    Heimdall.dll
    ...Deno 生成的运行文件
  README.md
  build-info.json
```

运行 `Heimdall/Heimdall.exe`。分发时保留完整 `Heimdall` 目录及其中的运行文件。
目标机器不需要安装 Deno；Windows 默认包需要 WebView2 Runtime。构建目录保存
运行库和应用资源，持久化业务数据使用用户数据目录。

```text
deno task desktop:build --backend cef
```

显式 CEF 构建写入 `dist/desktop/windows-x86_64-cef/`，随包携带 Chromium，
不依赖系统 WebView2 Runtime。macOS 使用 `Heimdall.app`，Linux 使用 `Heimdall`
目录，各后端均需在对应系统验收。

构建通过官方 `--icon` 包含应用图标。Deno 2.9.7 在 Windows 上仅生成旁置的
`AppIcon.ico`，因此 `desktop:run` 和 `desktop:build` 还在构建阶段通过 PowerShell
调用 Win32 资源 API，将原图嵌入最终 `.exe` 并回读验证。此步骤不进入应用运行时，
没有增加运行时 FFI。可执行文件资源已验证，原生窗口与任务栏是否采用该图标仍待
实际检查。

构建显式包含每个内置插件的 `mod.ts` 与 `manifest.json`，以及 `public/assets/`。
插件依赖仍由 Deno 的模块图收集，插件浏览器模块由独立浏览器构建产生。运行时使用
`import.meta.url` 定位内嵌资源，因此不依赖从仓库目录启动。SQLite 使用 Deno
提供的 `node:sqlite`，无需另行分发 SQLite 动态库。

## 数据与本机访问

| 系统    | 默认业务数据目录                                          |
| ------- | --------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%/Heimdall`                                 |
| macOS   | `~/Library/Application Support/Heimdall`                  |
| Linux   | `$XDG_DATA_HOME/heimdall`，默认 `~/.local/share/heimdall` |

用 `--data-dir PATH` 或 `HEIMDALL_DESKTOP_DATA_DIR`
选择业务数据目录。配置、对话、请求记录和图片分别保存在该目录内的 KV/SQLite
文件中。备份前退出应用，再整体备份目录。桌面数据与原服务模式的数据位置独立。

桌面宿主只监听
`127.0.0.1`，每次启动生成管理认证信息，原生窗口通过一次性启动凭据取得 HttpOnly
会话。网关 `/v1`
继续使用应用设置中的网关密钥；应用退出时停止处理请求。显式启用托盘后，隐藏期间
可继续处理请求。服务模式仍通过 `deno task start` 或 `deno task serve` 使用。

原生 Deno 桌面运行时通过 `DENO_SERVE_ADDRESS`
分配一个空闲端口，因此每次启动的本机网关端口可能不同。`--port` 和
`HEIMDALL_DESKTOP_PORT` 适用于无界面模式；需要固定服务端口时可运行现有服务任务。

使用 Windows WebView2 时，`desktop` 和 `desktop:dev` 在启动前尝试通过
`WEBVIEW2_USER_DATA_FOLDER`
指定浏览器配置目录；已有该变量时沿用设置。但当前原生后端仍可能在可执行文件旁建立
`Heimdall.exe.WebView2` 浏览器缓存，因此便携包必须放在当前用户可写的位置。业务
KV/SQLite 数据仍保存在上述用户数据目录。

## 窗口与托盘

主窗口使用无系统标题栏的原生窗口。Windows WebView2 关闭原生尺寸调整边框，
避免它在顶部留下白色区域；页面边缘和四角通过宿主命令调整窗口大小。Chat
和控制台的 HTML 标题栏提供拖动、展开／还原和关闭；双击标题栏也可切换展开状态。
展开使用当前显示器的可用区域调整窗口位置与大小，还原恢复普通窗口尺寸。 Deno
2.9.7 没有公开原生最小化、最大化或 Windows 原生按钮覆盖层 API，
因此这些交互使用窗口位置与尺寸接口。CEF 使用逻辑像素边界，Windows WebView2
使用物理像素；构建时嵌入后端标识用于坐标换算。默认关闭按钮退出应用，
显式启用托盘后显示隐藏到托盘操作。

页面标题栏的原生菜单提供以下操作；显式启用托盘后也可从托盘右键菜单访问：

- 打开 Chat 或管理控制台；
- 查看并复制本次启动的网关地址，打开业务数据目录；
- 切换窗口置顶，重置窗口位置与大小，重新加载界面；
- 退出 Heimdall；启用托盘后可隐藏到托盘，`--debug` 模式还可打开开发者工具。

桌面页面支持 `Ctrl+1` 打开 Chat、`Ctrl+2` 打开管理控制台、`Ctrl+W`
关闭窗口并退出应用；启用托盘后，`Ctrl+W` 改为隐藏到托盘。macOS 对应使用
`Cmd`。网页服务模式不显示桌面标题栏，也不注册这些窗口快捷键。

窗口的普通尺寸、位置与置顶设置保存在业务数据目录的
`desktop-window.json`。展开时保留普通窗口边界以便还原；重启后恢复普通窗口。
页面加载时会将窗口调整到当前显示器的可用区域，原生菜单中的“重置窗口位置与大小”
也可用于恢复窗口。丢失、损坏或不支持的窗口配置会使用默认尺寸。

默认关闭窗口即关闭 HTTP 服务、后台任务与存储，应用不驻留后台。 使用 `--tray`
启用托盘后，隐藏窗口时网关继续运行，托盘动作可显示或重建主窗口； 选择“退出
Heimdall”会结束应用。Windows WebView2 当前托盘点击存在上述上游缺陷，
开启选项不代表真实点击可用。

Deno 在最后一个原生窗口销毁后会结束桌面事件循环，因此宿主保留独立的 `noActivate`
隐藏窗口，以保证退出时能完成清理；默认模式不借此在后台常驻。第一个
`BrowserWindow` 接管 Deno 预建窗口，其创建样式已固定，运行时还会在 10 秒后再次
显示它。宿主仅将它作为启动占位窗口，待真正的隐藏窗口和无标题栏主窗口创建后将其
关闭，避免它重新进入任务栏。Deno 2.9.7 自行完成原生关闭，宿主清理兼容窗口已经
销毁的情况。

页面通过 `BrowserWindow.bind()`
提供的有限命令操作当前窗口。宿主在确认页面位于本机应用来源且已认证后，为该文档注入独立的调用能力；页面加载、窗口替换和退出会撤销旧能力。桥接不接受任意脚本、文件路径或系统命令。数据目录由宿主决定，原有
HTTP 管理会话继续负责业务操作认证。

## 检查

```text
deno task check:desktop
deno task desktop:smoke:headless
deno task desktop:smoke
deno task desktop:smoke:bundle
```

`check:desktop` 检查桌面宿主类型。无界面 smoke 检查真实回环服务、认证、动态内置
插件和浏览器资源；原生 smoke 在 `deno desktop` 下运行。Smoke 默认使用临时业务
数据，不修改日常使用的数据目录；不要为 smoke 指定正在使用的数据目录。

本地原生 smoke 使用 `local-<os>-<arch>-<backend>-smoke/` 构建目录，避免覆盖正在
日常运行的应用；例如 Windows 默认使用 `local-windows-x86_64-webview-smoke/`。

原生 smoke
通过程序点击页面按钮，检查桥接、展开／还原后的真实窗口尺寸、拖动与尺寸调整命令、
置顶和关闭后的退出清理；显式托盘模式另检查隐藏与窗口重建。任务复制应用到临时目录
运行，并隔离业务数据；读取成功报告后等待进程退出并清理目录。这些检查不验证真实
托盘左右键、原生边框外观或任务栏图标，仍需实际 Windows 交互验收。

`desktop:smoke:bundle` 直接检查 `desktop:build`
的产物，不重新构建。它从临时工作目录启动应用，验证资源不依赖仓库路径，通过后将不含凭据的结果保留在产物目录内的
`smoke-result.json`。也可传入其他已构建桌面可执行文件的绝对路径。

完整项目检查仍使用 `deno task verify`。发布验收还应实际打开产物，确认
Chat、控制台、边缘尺寸调整、标题栏和任务栏图标，以及默认关闭窗口能够结束进程
与网关服务。启用托盘模式时还应单独验收真实托盘点击和退出。

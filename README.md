# dsh-task-notify

DeepSeek Harness 桌面端插件：**每次任务完成（以及 DSH 停下来等你选择 / 批准）时发出提示音、闪烁任务栏图标、并在任务栏图标上显示角标**；当你切回 DSH 窗口后，角标自动消失。

## 功能

| 提示 | 实现方式 | 关闭条件 |
| --- | --- | --- |
| 🔔 提示音 | 渲染端播放 `assets/*.wav`；若渲染端没在轮询，则由宿主用 `Media.SoundPlayer` 兜底发声 | 播完 |
| ✨ 任务栏闪烁 | 外部常驻进程调用 Win32 `FlashWindowEx(FLASHW_ALL \| FLASHW_TIMERNOFG)`，并由看护线程**每 900ms 重新上发条** | 窗口进入前台 |
| 🔴 角标 | 外部常驻进程调用 `ITaskbarList3::SetOverlayIcon`，在任务栏按钮右下角画一个红点/绿勾 | 窗口进入前台（发通知时你本来就在窗口前的话，至少展示 `badgeMinMs`） |
| ⏸️ 等你选择 / 批准 | 同上三者；由 `user-questions/request`、`approval/request` 两条瀑布事件触发 | 窗口进入前台（能自己决出结果的请求不打扰你） |

即：**任务完成、或 DSH 停下来等你点一下时，一直闪、角标一直在，直到你把 DSH 切到前台。**

三者可以独立开关（见下方配置）。

## 设置界面

插件在 DSH 设置面板里注册了独立一页 **「任务提醒」**（挂在 `settings.section` 槽，order 12），可以在里面：

- 开关提示音、拖动音量（0–100%）；
- 在音效列表里单选（点 **▶ 试听** 先听一遍）——内置 3 种：清脆铃声 / 叮咚 / 气泡；
- **导入自己的音效**：填显示名称（留空用文件名）→ 选择文件 → 导入。支持 `wav / mp3 / ogg / m4a / aac / flac / webm`，单个 ≤ 8 MB；导入后自动选中，旁边会多出「删除」按钮；
- 开关任务栏闪烁与角标，切换角标样式（红点 / 绿勾）；
- 「提醒时机」里可以关掉 **等我选择 / 批准时也提醒**（默认开着）。

设置页里的改动**立即写盘并生效**，不需要重启。但要让这一页出现，需要重启一次 DSH——客户端半边的 bundle 只在启动时挂载（见下方「安装」）。

## 为什么要用「外部进程」

DSH 桌面端把宿主运行在 `ELECTRON_RUN_AS_NODE=1` 的子进程里（`resources/app.asar` → `lib/main.js` 用 `spawn` 启动 `@deepseek-ai/dsh-desktop-host`），插件拿到的是 Node 环境，`require('electron')` 给不出 `BrowserWindow`；`preload-app.cjs` 暴露的 `dshDesktop` API 里也没有 `flashFrame` / `setOverlayIcon`；`DESKTOP_IPC` 频道表里没有任何任务栏相关通道。

所以本插件走**进程外 Win32**：`native/TaskbarNotify.cs` 编译成常驻小 exe，宿主通过 stdin/stdout 用纯文本协议指挥它。这样还有两个好处：

- `SetOverlayIcon` 的 `HICON` 必须由一个**一直活着**的进程持有，一次性进程退出后角标会失效；
- 常驻进程自己轮询 `GetForegroundWindow()`，不依赖渲染端脚本就一定能在你回到窗口时清掉角标。

## 安装

插件源码在 `C:\Users\ZJY\.dsh\plugins\dsh-task-notify`，以 `link:` 方式挂进 desktop profile。

```powershell
dsh plugin --profile desktop add link:C:\Users\ZJY\.dsh\plugins\dsh-task-notify
```

如果那条命令不可用，手工三步等价（本机已用该方式装好）：

1. 建目录联接：
   ```powershell
   New-Item -ItemType Junction `
     -Path  C:\Users\ZJY\.dsh\profiles\desktop\node_modules\dsh-task-notify `
     -Target C:\Users\ZJY\.dsh\plugins\dsh-task-notify
   ```
2. 在 `C:\Users\ZJY\.dsh\profiles\desktop\package.json` 里加依赖：
   ```json
   "dependencies": { "dsh-task-notify": "link:C:\\Users\\ZJY\\.dsh\\plugins\\dsh-task-notify" }
   ```
3. 把 `"dsh-task-notify"` 加到同一个文件的 `dsh.profile.bundles` 数组末尾。

装完**重启 DeepSeek Harness** 生效（`cordis.yml` 是启动时按 bundles 顺序重新生成的，普通热重载不会新增 loader 行）。

插件同时声明了**客户端半边**：`package.json` 里 `exports["./client"]` 指向 `lib/client.js`，`dsh.client` 声明 `platform: "web"` / `immediately: true`。DSH 启动时由 `@deepseek-ai/dsh-client-modules` 把它作为 bundle 挂在 `/plugins/dsh-task-notify/client.js`，在浏览器里注册设置页；它只 `require("react")`（平台种子模块），不引入任何额外依赖。所以**打包/安装时 `lib/client.js` 必须已经存在**，否则启动阶段会直接报 activation 失败。

首次运行时插件会自动用 `csc.exe` 把 `native/TaskbarNotify.cs` 编译成 `native/bin/dsh-taskbar-helper.exe`（几十毫秒，之后缓存；`.cs` 改动后会自动重编）。

## 命令

- `dshctl` 与本插件无关，不用动。
- 删除：从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里去掉 `dsh-task-notify`，删掉联接即可。

## 配置

配置文件：`C:\Users\ZJY\.dsh\dsh-task-notify.json`（不存在则用默认值，首次触发时写入）。
自导入的音效放在 `C:\Users\ZJY\.dsh\dsh-task-notify\sounds\<slug>.<ext>`（设置页里的导入 / 删除就是在管这个目录）。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `promptEnabled` | `true` | 等你选择 / 批准（选项、计划复核、批准请求）时也提醒 |
| `soundEnabled` | `true` | 是否播放提示音 |
| `soundName` | `"chime"` | 内置 `chime` / `ding` / `pop`，或自导入音效 `c:<slug>` |
| `volume` | `0.7` | 0–1 |
| `flashEnabled` | `true` | 是否闪烁任务栏按钮 |
| `badgeEnabled` | `true` | 是否显示角标 |
| `badgeIcon` | `"dot"` | `dot`（红点）/ `check`（绿勾） |
| `badgeClearOnFocus` | `true` | 切回窗口后清除角标 |
| `badgeMinMs` | `1500` | 角标最短展示时长（发通知时窗口已在前台时至少露脸这么久） |
| `minTurnMs` | `0` | 本轮至少持续多久才算「一个任务」，过滤掉瞬时的碎回合 |
| `debounceMs` | `1500` | 静默期：已经有这么长时间没有任何会话活动，才判定「全部忙完了」 |
| `cooldownMs` | `2000` | 两次提醒之间的最小间隔 |

也可以运行时改。注意：**外部 PowerShell 直接请求会被 DSH 的信任栅栏挡成 401**，要在 DSH 页面自己的开发者工具 console 里调用：

```js
await (await fetch('/dsh-task-notify/config')).json()                    // 读
await fetch('/dsh-task-notify/config', { method: 'POST', body: '{"soundName":"pop"}' })  // 局部改
await fetch('/dsh-task-notify/test', { method: 'POST' })                 // 立刻试一次提醒
```

## 触发逻辑

不是简单的 `turn/end` 就响——那样子代理和 workflow 每结束一个都会响一次。这里是**「全都忙完了」语义**：

- 任何 `session/event`（非 `turn/end`）、`api-session/status(running=true)`、`agent/status(status === "running")` 都只是刷新 `lastBusyAt`（忙标志）；
- `turn/end` 时记下 `pendingEnded` 并启动 `debounceMs` 的定时器；
- 定时器到点时若 `lastBusyAt` 还太新就再等一轮；否则检查 `minTurnMs` / `cooldownMs`，通过就响。

另有一条独立的提醒路径，专门补「等你点一下」的盲区：DSH 停下来问你时（选项提问、计划复核、批准请求）**回合并没有结束**——日志里提问与回答之间不出现任何 `turn/end`，等整轮跑完再提醒，你早就回来了。所以插件旁听 `user-questions/request` 与 `approval/request` 两条瀑布事件（只旁观，`next()` 原样放行，绝不介入裁决），并用 `PROMPT_GRACE_MS = 800` 的宽限滤掉「自己就决出结果」的请求：只读 / `never` 审批策略下批准会被立刻自动拒绝，那种不该打扰你。`promptEnabled: false` 可关掉这条路径。

这样即使某个子代理的结束事件丢了、或者忙标志卡住，最多也只是延迟，不会永久哑掉。

## 文件结构

```
dsh-task-notify/
├── package.json          # dsh.bundle.patch + dsh.client（客户端半边声明）
├── cordis.patch.yml      # 向 profile 插入本插件
├── README.md
├── docs/preview.png      # 任务栏效果预览
├── assets/
│   ├── chime.wav / ding.wav / pop.wav
│   ├── badge-dot.ico          # 16/24/32/48
│   └── badge-check.ico        # 16/24/32/48
├── native/
│   ├── TaskbarNotify.cs       # 常驻 Win32 助手（csc 编译）
│   └── bin/                   # 编译产物 dsh-taskbar-helper.exe
├── tools/
│   ├── selfcheck.mjs          # 宿主半边离线自检（mock ctx）
│   └── selfcheck-client.mjs   # 客户端半边离线自检（替身 React）
└── lib/
    ├── index.js          # 宿主插件：事件汇聚 + HTTP 路由 + index 注入 + 原生助手管理 + 音效库
    ├── native.js         # 编译/启动/重连 helper，stdin/stdout 协议
    ├── beacon.js         # 注入渲染端：轮询事件、播音效、回报焦点（宿主路由 /beacon.js）
    └── client.js         # 客户端半边：注册设置面板「任务提醒」页（走 /plugins/.../client.js）
```

> `lib/beacon.js` 与 `lib/client.js` 是两条不同的路：前者是宿主注入的普通 `<script>`（同源 URL `/dsh-task-notify/beacon.js`），后者是 `dsh-client-modules` 加载的浏览器 bundle（URL `/plugins/dsh-task-notify/client.js`）。

## 接口

宿主注册的 HTTP 路由（都走 DSH 的 `connection.requestRejection` 信任栅栏）：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-task-notify/beacon.js` | GET | 注入到页面的客户端脚本（轮询 + 播放 + 焦点回报） |
| `/dsh-task-notify/events` | GET | `?since=<seq>` → `{ok, seq, serverTime, events:[{seq, type:'done'\|'error', ts}], config}` |
| `/dsh-task-notify/config` | GET/POST | 读/写配置，POST 走字段白名单；GET 还返回 `sounds` 清单与 `soundsDir` |
| `/dsh-task-notify/focus` | POST | 渲染端报告窗口获得焦点 |
| `/dsh-task-notify/soundfallback` | POST | 渲染端报告「播不出声」，请宿主兜底发声 |
| `/dsh-task-notify/test` | GET/POST | 立刻触发一次提醒 |
| `/dsh-task-notify/sound` | GET | `?id=<chime\|c:slug>` → 音频字节流（`Content-Type` 按扩展名） |
| `/dsh-task-notify/sounds` | GET | 音效清单：内置 + 自导入，含 `maxBytes` / `formats` |
| `/dsh-task-notify/sounds/import` | POST | `{name, ext, data(base64)}` → 落盘到 sounds 目录并返回新条目 |
| `/dsh-task-notify/sounds/delete` | POST | `{id}` → 只能删自导入的；删掉的若是当前音效则回落默认 |

导入相关的 id 一律形如 `c:<slug>`，slug 由 `[\p{L}\p{N}_-]{1,40}` 约束，加上删除前的 `path.resolve` 包含性校验，杜绝路径穿越。

助手协议（宿主 → 助手 stdin）：`flash`、`stopflash`、`badge <ico绝对路径>`、`badgeclear`、`badgemin <ms>`、`hwnd`、`ping`、`quit`；
（助手 → 宿主 stdout）：`READY <hwnd>`、`WINDOW <hwnd>`、`FOCUS <hwnd>`、`BADGED`、`BADGECLEARED`、`FLASHING`、`PONG`、`ERR <msg>`。

## 验证

**离线自检**（不需要 DSH 在跑，用 mock ctx 直接加载真实插件代码）：

```powershell
node C:\Users\ZJY\.dsh\plugins\dsh-task-notify\tools\selfcheck.mjs         # 宿主半边，45 项断言
node C:\Users\ZJY\.dsh\plugins\dsh-task-notify\tools\selfcheck-client.mjs  # 客户端半边，28 项断言
```

`selfcheck.mjs` 会覆盖路由注册 / index 注入 / 音效清单·导入·试听地址·删除 / 配置校验 / 事件汇聚时序 / 信任栅栏 / 释放，期间会真的闪一下任务栏（走的是真实原生助手），跑完自动恢复配置文件并删掉自己导入的测试音效。
`selfcheck-client.mjs` 用替身 React 替身浏览器跑 `lib/client.js`，检查 bundle id、导出契约、`settings.section` 注册内容与设置页元素树。

**装好后在运行中的 DSH 里验证**：随便让一个任务结束，应当听到提示音、任务栏按钮开始闪并出现红点；点回 DSH 窗口后角标消失。想立刻试，在页面 console 里 `await fetch('/dsh-task-notify/test', {method:'POST'})`。设置页在 **设置 → 任务提醒**。

判断插件有没有被加载：外部直接请求这些路由会得到 **401（存在）**，未注册的路径是 **404**，可用这个区分：

```powershell
try { Invoke-WebRequest http://127.0.0.1:19387/dsh-task-notify/beacon.js -UseBasicParsing } catch { $_.Exception.Response.StatusCode.value__ }
```

## 排障

- **没有提示音**：多半是渲染端脚本没被注入（检查宿主 console 的 `[dsh-task-notify]` 日志）。渲染端播放失败时它会主动调 `/soundfallback`，宿主改用 `Media.SoundPlayer` 兜底；轮询整个断了的话宿主也会自动兜底，所以听不到才是真的没发声。
- **任务栏没反应**：先看宿主 console 里 `[dsh-task-notify]` 的 `helper=` 是不是 `ready`；不是的话助手启动失败（编译不了 `TaskbarNotify.cs`，或找不到 DSH 主窗口）。
- **角标一闪而过**：调大 `badgeMinMs`。
- **设置里没有「任务提醒」这一页**：客户端半边的 bundle 只在 DSH 启动时挂载，改完 `lib/client.js` / `package.json` 必须重启一次；再看浏览器 console 有没有 `[dsh-task-notify] 设置页注册失败`。宿主侧路由是否在线可以用上面的 401/404 判断法。
- **子代理结束时也想响**：调小 `debounceMs`。
- **助手进程残留**：`Get-Process dsh-taskbar-helper`，父进程退出时它会自己结束（stdin EOF）。
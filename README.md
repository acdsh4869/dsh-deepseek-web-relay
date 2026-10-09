# dsh-deepseek-web-relay

在 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 左侧边栏添加一个原生菜单项，
一键打开 **chat.deepseek.com** 独立窗口，支持与 DSH **双向划词互传**。

[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5_0.1.5--rc.3-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](./LICENSE)
[![Topic](https://img.shields.io/badge/topic-dsh--plugin-2EA043?style=flat-square)](https://github.com/topics/dsh-plugin)

---

## 🌟 特性亮点

- **一键直达** —— 左侧边栏原生菜单项，点击即开独立窗口，登录一次长期保留。
- **双向划词互传** —— DSH 里划词直接送进网页端；网页端划词一键接力回 DSH。
- **不打扰日常划词** —— 普通划词（复制 / 搜索 / 查看）**不会**弹气泡；需按住 <kbd>Alt</kbd> 划词或右键选区才出现传送按钮。输入框、搜索框、代码块、菜单、侧栏、表格里**一律不弹**。
- **一键分支新对话** —— 网页端 AI 回复末尾点 **↪ 分支到 DSH**，上下文自动填进 DSH 新会话。
- **零依赖、免构建** —— 无 `node_modules`、无编译，装完重启即可用。
- **故障不静默** —— 打开失败、注入失败都会在右下角提示具体原因。

![侧边栏中的 DeepSeek Relay 菜单项](docs/images/sidebar-menu.png)

![按住 Alt 划词后浮现的「传给Chat」气泡](docs/images/selection-bubble.png)

---

## 🚀 快速开始

**环境要求**：DSH ≥ `0.1.5-rc.3` · 系统装有 Chrome 或 Edge · Windows

**一条命令安装**：

```bash
dsh plugin --profile <profile> install acdsh4869/dsh-deepseek-web-relay
```

装完**重启 DSH 实例**，再按 `Ctrl+Shift+R` 硬刷新页面。

> 也提供幂等的 `install.ps1` 安装脚本，详见[技术文档](docs/TECHNICAL.md)。

**从旧版（`dsh-deepseek-chat` / `dsh-deepseek-web`）升级**

v2.0.0 是一次破坏性改名，包名、路由前缀、slot id、浏览器用户数据目录全变了。
**必须先卸载旧版**，否则 profile 的 `bundles` 里会同时留着旧包名而两个都不加载：

```powershell
# 1. 进旧版插件目录跑卸载
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome "<DSH 实例 Home>" -Profile <profile>

# 2. 再装新版
dsh plugin --profile <profile> install acdsh4869/dsh-deepseek-web-relay
```

**登录态想保留**，把旧的 profile 目录改个名再重启（否则要重新登录一次）：

```powershell
Rename-Item "<DSH 实例 Home>\deepseek-chat-profile" deepseek-web-relay-profile
```

旧的诊断文件 `%TEMP%\dsh-deepseek-chat-status.json` 可以直接删掉，新版写的是
`%TEMP%\dsh-deepseek-web-relay-status.json`。

---

## 📖 使用指南

**打开窗口**

1. 点击左侧边栏的 **DeepSeek Relay** 菜单项（侧边栏收起时，先点左上角展开）。
2. 首次在弹出的窗口里登录一次 DeepSeek，此后一直保持登录。

![侧边栏菜单项](docs/images/sidebar-menu.png)

**双向划词互传**

1. 在 DSH 里选中文字 → 按住 <kbd>Alt</kbd> 划词（或划完词再补按 <kbd>Alt</kbd>，或直接右键选区）→ 点 **🐋 传给Chat** → 送入网页端输入框。
2. 在网页端选中文字 → 点气泡 → 接力回 DSH 输入框。

> **划词怎么都不会出气泡？** 这是 v1.6.0 起的**预期行为**：默认不再「划词即弹」，
> 因为日常划词多数是为了复制 / 搜索 / 查看，弹气泡反而挡住界面。
> 三种触发方式任选其一：
>
> | 方式 | 操作 |
> |---|---|
> | 按住修饰键划词 | <kbd>Alt</kbd> + 拖选文字 |
> | 划完词补按修饰键 | 正常划词 → 4 秒内按一下 <kbd>Alt</kbd> |
> | 右键选区 | 对选区点右键（气泡出现在光标处） |
> | 快捷键直发（最省心） | 划完词按 <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>，**不经过气泡** |
>
> 想要「划词就弹」的老行为，把 `bubbleTrigger` 设成 `select`（见下方设置表）。

![划词气泡](docs/images/selection-bubble.png)

**哪些地方不会出气泡（v1.6.0 起）**

输入框 / 搜索框 / 代码块 / 按钮与链接 / 菜单与弹窗 / 侧栏会话列表 / 表格 / 筛选标签 ——
这些位置划词一律不弹，不会再挡住界面。

> **已知限制**：插件市场里插件卡片的「描述文字」拦不住（它是普通段落，
> 语义上与对话正文无法区分）。这类场景由「必须按住 Alt 才弹」兜住 ——
> 普通划词依然完全不弹。想要更严可设 `bubbleScope: conversation`。

**一键分支新对话**

1. 在网页端任意一条 AI 回复末尾，点 **↪ 分支到 DSH**。
2. DSH 自动新建会话，并把截至该回复的对话上下文（`User:` / `Assistant:` 逐轮）填进输入框。
3. 失败时内容自动复制到剪贴板，按提示手动粘贴即可，内容不丢。

---

## 🛠️ 常用设置

配置写在插件自身的 `cordis.patch.yml` 的 `config:` 下，改完需**重启 DSH 实例**生效。

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `relayAppendMode` | `replace` | 接力写入方式；`append` 为追加 |
| `branchIncludeHistory` | `true` | 分支带全部历史；`false` 只带点击的那条回复 |
| `branchMaxChars` | `5000` | 分支上下文的字符上限，超出截断 |
| `placement` | `over-dsh` | 窗口位置；`center` 交给系统放置 |
| `browserPreference` | `auto` | 浏览器选择；可强制 `chrome` 或 `edge` |
| `sidebarInset` | `268` | 窗口给侧边栏留的宽度；挡住侧边栏就调大 |
| `relay` | `true` | 划词互传总开关；设 `false` 彻底关闭 |
| `bubbleTrigger` | `modifier` | 气泡触发方式（v1.6.0 默认由 `select` 改为 `modifier`）。`modifier`=按住 Alt 划词 / 划完词补按 Alt / 右键选区；`contextmenu`=仅右键；`select`=旧行为，划词即弹（**仍不会在输入框、代码块、菜单等处弹**）；`off`=关闭气泡 |
| `bubbleModifier` | `alt` | `modifier` 模式用哪个修饰键：`alt` / `ctrl` / `shift` / `meta` |
| `bubbleAutoHideMs` | `6000` | 气泡无操作自动消失时间（毫秒）；`0` = 不自动消失 |
| `bubbleArmWindow` | `4000` | 「先划词再按修饰键」的待命窗口（毫秒），超时后按修饰键不弹 |
| `bubbleScope` | `input-excluded` | 准入范围。默认只排除语义上明确不是正文的区域（输入框/搜索框/代码块/按钮/菜单/侧栏/表格/筛选标签）；`conversation` 更严，额外要求选区落在「像对话正文」的容器里 |
| `hotkeySend` | `ctrl+shift+s` | A→B **快捷键直发**：划词后按此组合键直接发送，绕开点气泡的指针链路；空字符串 = 禁用 |

例如切换为追加模式：

```yaml
config:
  relayAppendMode: append
```

想恢复「划词就弹」的老行为：

```yaml
config:
  bubbleTrigger: select
```

> ⚠️ 改完 `bubbleTrigger` 等配置后，**必须重启 DSH 实例**才生效 ——
> 这些值由宿主进程（`index.js`）下发，改磁盘文件不会影响正在运行的实例。

> [完整配置表](docs/TECHNICAL.md#完整配置项)见技术文档。

---

## ❓ 常见问题

**为什么是独立窗口，不直接嵌进 DSH？**

chat.deepseek.com 的站点安全策略（禁止 iframe 嵌入、WAF 机器人挑战、Cookie 限制）让「内嵌」技术上不可行。独立窗口是当前最接近的方案，详细分析见[技术文档](docs/TECHNICAL.md#为什么不能内嵌进-dsh)。

**为什么接力默认是覆盖，不是追加？**

追加会让草稿越攒越长，DSH 输入框变卡、内容重复出现；覆盖每次写入规模恒定，从机制上杜绝累积。确实要攒多条，就开 `append` 模式。

**菜单项点不动或找不到？**

- 侧边栏收起时菜单不可见，先展开侧边栏。
- 窗口可能开在其他显示器，或被别的窗口挡住。
- 看右下角提示，它会告诉你具体原因。

**划词怎么不出气泡了？（v1.6.0 起的预期行为）**

默认改成「按住 <kbd>Alt</kbd> 划词」才弹，或划完词 4 秒内补按 <kbd>Alt</kbd>，
或直接右键选区。这是刻意改的 —— 划词多数是为了复制 / 搜索 / 查看，
弹气泡反而挡住输入框和界面。四种触发方式见上方「📖 使用指南 → 双向划词互传」一节。

**怎么确认装的是新版、配置有没有生效？**

读 `%TEMP%\dsh-deepseek-web-relay-status.json`，找 `overlay-rendered` 这一项：

```json
{ "trigger": "modifier", "modifier": "alt", "scope": "input-excluded" }
```

看到 `modifier` 就是新版。若显示 `select`，说明宿主还在跑旧代码 —— **重启 DSH 实例**。
另外这个文件里的 `bubble-none` / `why: "zone:xxx"` 能告诉你某处区域是被哪条规则拦下的。

---

## 📄 更多

- [技术文档](docs/TECHNICAL.md) —— 安装脚本、卸载方式、完整配置表、实现原理
- [v1.6.0 改动说明](MIGRATION-1.6.0.md) —— 气泡触发逻辑重编的根因、改法与验证清单

---

## 📝 更新日志

- **v2.0.0**（2026-10-09）**改名 `dsh-deepseek-chat` → `dsh-deepseek-web-relay`**（菜单项显示名 `DeepSeek Relay`），并补上插件图标与双语元数据。这是一次**破坏性改名**：包名、路由前缀、slot id、浏览器用户数据目录全部变化，**旧版必须先卸载**（见下方「从旧版升级」）。
- **v1.6.0**（2026-10-06）**气泡触发逻辑重编 —— 不再干扰日常划词**。默认由「划词即弹」改为「**按住 Alt 划词 / 划完词补按 Alt / 右键选区**」才弹；新增**语义区域闸门**，输入框、搜索框、代码块、按钮、菜单、侧栏、表格、筛选标签等区域**一律不弹**；补上此前缺失的滚动 / 缩放 / 失焦收起（气泡不再滚动后悬在界面上）；新增 `bubbleAutoHideMs` 自动消失兜底；快捷键直发不再走选区缓存兜底。详见[改动说明](MIGRATION-1.6.0.md)。
- **v1.5.0**（2026-10-01）重编气泡命中：药丸加大 + **22px 透明命中光环**（点光环任意位置都算点中，有效面积近 6 倍），成功态延长到 1.5s；新增 CDP 自动化自测 `tools/selftest-bubble.cjs`（三项全部 PASS）。
- **v1.4.0**（2026-10-01）重编 A→B 传送主通道：**快捷键直发**（默认 `Ctrl+Shift+S`），物理绕开壳层吞指针事件导致的「点好几下没反应」；气泡保留为辅助通道；新增 `hotkey-send` / `hotkey-none` / `bubble-blocked` / `bubble-miss` 全量埋点。
- **v1.3.0**（2026-10-01）重写交互反馈：气泡改在**鼠标光标处**冒出（不再锚选区顶部）；注入后把**真正收到内容的那一页**精确拉到前台；成功提示带内容预览。
- **v1.2.2**（2026-10-01）修复「点好几下都没反应」：发送失败时气泡变为「✗ 失败，点击重试」留在原地可立即重试（不再吞掉后续点击）；窗口没开时点气泡会**自动打开窗口再注入**，一次点击完成全链路。
- **v1.2.1**（2026-10-01）修复划词传送偶发失败：选区落在 Shadow DOM 内时 `getSelection()` 读不到，现回退 `getComposedRanges()` 穿透读取；选区缓存兜底延长到 4 秒。
- **v1.2.0**（2026-10-01）新增配置 `bubbleTrigger`：`contextmenu` 模式下划词不再冒气泡，对选区**右键**时「🐋 传给Chat」才出现在光标处（更安静，适合常驻第二实例）。
- **v1.1.2**（2026-10-01）修复 DSH 划词后气泡不出现（no-selection）：拖选过程持续缓存选区（selectionchange），mouseup 三层读取兜底；即使界面重渲染清掉选区，气泡照样冒出来。
- **v1.1.1**（2026-10-01）修复 DSH 划词气泡「点一下没反应、要连点好几下」：点击后气泡立即显示「✓ 已发送」再消失，且发送后短时间内不再原样冒回；A→B 注入的 CDP 自愈链路整体提速，杜绝「点了 20 秒没反应」。
- **v1.1.0**（2026-09-30）新增「分支到 DSH 新对话」：网页端每条 AI 回复末尾一键把上下文带进 DSH 新会话；新增配置 `branchButtonText` / `branchMaxChars` / `branchIncludeHistory`。
- **v1.0.0**（2026-09-29）初始版本正式发布。实现在 DSH 左侧边栏一键打开 DeepSeek 独立窗口，并支持双向划词互传。

---

## License

[MIT](./LICENSE)

# dsh-deepseek-web-relay 技术文档

面向想了解实现细节、需要完整配置或使用脚本安装/卸载的用户。
日常使用看 [README](../README.md) 即可。

---

## 安装脚本

除了 README 中的官方 CLI，也可以用仓库自带的脚本安装：

```powershell
# 1) 关闭正在运行的 DSH 实例
# 2) 在插件目录下执行
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome <DSH 实例 Home 目录>
```

脚本会建立 `node_modules` 目录联接、把包名登记进 `dsh.profile.bundles`、备份原 `package.json`，并跑一次自检。
脚本是**幂等**的，重复执行安全。

安装成功的标志：自检输出 `[OK] dump-config 里已出现 dsh-deepseek-web-relay —— 插件会被加载`。

### 验证安装

```powershell
Get-Content "$env:TEMP\dsh-deepseek-web-relay-status.json"
```

`registered` 数组应包含 `sidebar.panellist#dsh-deepseek-web-relay-panel`。

### 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome <DSH 实例 Home 目录>
```

脚本会**先**从 `dsh.profile.bundles` 移除包名、**再**删除 `node_modules` 联接
（顺序重要：保留联接未登记不影响，保留登记却无联接会报错）。重启实例后即不再加载。

**快速禁用**：编辑 `cordis.patch.yml`，注释掉 `insert:` 行后重启实例。插件完全不加载，DSH 照常运行。

```yaml
# - insert:
#     - id: dsh-deepseek-web-relay
#       name: dsh-deepseek-web-relay
```

---

## 完整配置项

所有配置写在插件自身的 `cordis.patch.yml` 的 `config:` 下。该文件同时也是插件的启用开关。

```yaml
- insert:
    - id: dsh-deepseek-web-relay
      name: dsh-deepseek-web-relay
      config:
        placement: over-dsh
```

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `url` | string | `https://chat.deepseek.com` | 打开的地址，须为 http(s) |
| `browserPreference` | `auto` \| `chrome` \| `edge` | `auto` | `auto` = Chrome 优先、Edge 兜底 |
| `placement` | `over-dsh` \| `center` | `over-dsh` | `over-dsh` 贴合 DSH 窗口内容区；`center` 由系统放置 |
| `sidebarInset` | number | `268` | `over-dsh` 时为左侧边栏预留的宽度（px） |
| `gap` | number | `10` | 窗口四周留白（px） |
| `minWidth` / `minHeight` | number | `520` / `460` | 窗口最小尺寸（px） |
| `relay` | boolean | `true` | 划词互传总开关。设为 `false` 则不开启调试端口、不注入脚本 |
| `relayPrefix` | string | 见下 | 接力时注入的前缀，须与网页端脚本保持一致 |
| `relayMaxChars` | number | `2000` | 单次互传字符上限，超出硬截断 |
| `relayAppendMode` | `replace` \| `append` | `replace` | 接力写入方式 |
| `draftMaxChars` | number | `6000` | 输入框草稿总长上限，仅 `append` 模式生效 |
| `ackTimeoutMs` | number | `15000` | 网页端等待 DSH 回执的上限（毫秒） |
| `transferPrefix` | string | `【来自 DSH 上下文】` | A → B 注入时的前缀，留空则不加 |
| `branchButtonText` | string | `"↪ 分支到 DSH"` | 网页端每条 AI 回复末尾的分支按钮文字 |
| `branchMaxChars` | number | `5000` | 分支抓取内容的字符上限，超出硬截断（合法范围 500..50000） |
| `branchIncludeHistory` | boolean | `true` | `true` 带截至点击处的全部历史；`false` 只带被点击的那条回复 |

### 划词气泡（v1.6.0 新增配置）

气泡在 DSH 里划词后浮现「🐋 传给Chat」。v1.6.0 起默认不再「划词即弹」，
普通划词（复制、搜索、查看）一概不打扰，需明确的传送手势才弹出。

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `bubbleTrigger` | `modifier` \| `contextmenu` \| `select` \| `off` | `modifier` | `modifier`=按住修饰键划词或先划词再按修饰键；`contextmenu`=对选区右键；`select`=旧行为划词即弹（仍受区域闸门约束）；`off`=关闭气泡 |
| `bubbleModifier` | `alt` \| `ctrl` \| `shift` \| `meta` | `alt` | `modifier` 模式下用哪个修饰键 |
| `bubbleArmWindow` | number | `4000` | 「先划词再按修饰键」的待命窗口（毫秒），超时后按修饰键不弹 |
| `bubbleAutoHideMs` | number | `6000` | 气泡无操作自动消失时间（毫秒），`0` = 不自动消失 |
| `bubbleScope` | `input-excluded` \| `conversation` | `input-excluded` | 准入范围。默认只排除语义上明确不是正文的区域（输入框/搜索框/代码块/按钮/菜单/侧栏/表格/筛选标签…）；`conversation` 更严，额外要求选区落在「像对话正文」的容器里 |

配合 `hotkeySend`（默认 `ctrl+shift+s`）使用最省心：划完词按快捷键直接发送，
完全不经过气泡的指针链路，也就不存在气泡遮挡界面的问题。

`relayPrefix` 默认值：`【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】`

> 修改配置后**需要重启 DSH 实例**（宿主半边不热更新）。仅修改 `client.js` 无需重启，硬刷新页面即可。

---

## 技术设计

### 组件结构

| 文件 | 角色 |
|---|---|
| `package.json` | 插件清单：`dsh.bundle.patch` + `dsh.client` + `exports["./client"]` |
| `cordis.patch.yml` | 启用开关与配置 |
| `index.js` | 宿主半边（Node 进程）：HTTP 路由、启动浏览器窗口、CDP 通道 |
| `client.js` | 客户端半边（网页内）：左侧菜单项与划词气泡，全部 UI |
| `page-script.js` | 注入到 chat.deepseek.com 页面中的脚本：划词与回传 |
| `install.ps1` / `uninstall.ps1` | 安装与卸载（幂等） |
| `tools/patch-bundles.cjs` | 安全增删 `dsh.profile.bundles` 的辅助工具 |

### UI 挂载点

插件向 DSH 注册三个 slot：

| slot | 作用域 | 用途 |
|---|---|---|
| `sidebar.panellist` | 列表 | 左侧边栏菜单项 **DeepSeek Relay** |
| `shell.overlay` | root | 划词气泡（无会话时也可用） |
| `conversation.session.header.utilities` | session | 接力桥，负责把内容写入 DSH 输入框 |

`sidebar.panellist` 与 `conversation.session.header.utilities` 均为 list 类型 slot，
按 DSH 规范**必须携带 `id`**；`sidebar.panellist` 的子表可能晚于 `sidebar` 声明，
因此注册逻辑带退避重试。

### 划词互传的数据链路

```
chat.deepseek.com 页面中的 page-script.js
   │  window.__dshRelay(json)        ← 由 CDP Runtime.addBinding 注册
   ▼
独立 Chrome 窗口的调试端口 127.0.0.1:<随机端口>（--remote-debugging-port）
   │  CDP WebSocket（宿主主动连接）
   ▼
宿主半边 index.js：入队 + 将 DSH 窗口置于前台
   │  GET /dsh-deepseek-web-relay/relay?since=N（客户端轮询，间隔 800ms）
   ▼
客户端半边 client.js → inputActions.setDraft(前缀 + 内容)
```

反向（A → B）复用同一条 CDP 通道，方向相反：

```
DSH 划词气泡（client.js）
   │  POST /dsh-deepseek-web-relay/inject { text }
   ▼
宿主半边 index.js → CDP Runtime.evaluate
   ▼
page-script.js 的 window.__dshInjectText(text) → 写入网页端输入框
   │
   └─ 失败时兜底：写入系统剪贴板并提示手动粘贴
```

### 分支到 DSH 新对话（v1.1.0）

网页端每条 AI 回复末尾有「↪ 分支到 DSH」按钮，链路与 B→A 接力共用一条通道：

```
page-script.js（按钮点击，抓 User/Assistant 逐轮上下文）
   │  window.__dshRelay({ kind:'branch', id, text, meta })   ← CDP binding
   ▼
宿主半边 index.js：入 relayQueue（isBranch:true，独立 branchSeq）
   │  GET /dsh-deepseek-web-relay/relay?since=N（客户端轮询）
   ▼
客户端半边 client.js → applyBranch：
   ① 缓存到 window.__dshPendingBranch
   ② 模拟点击 DSH「新建会话」按钮（[aria-label="新建会话"] 优先，多套备选，≤5 次 × 500ms）
   ③ 轮询等新会话挂载（≤15 次 × 500ms）：sessionInput.setDraft 可用
      且（输入框换了新节点 / 已等 3s）
   ④ sessionInput.setDraft(text) —— replace 覆盖写入，绝不追加
   ⑤ 失败兜底：内容写剪贴板 + 提示手动粘贴；结果经 /relay-ack 回执网页端按钮
```

- 队列游标仍是共享的 `relaySeq`（`/relay?since=` 语义不变）；`branchSeq` 只给分支消息编号。
- 按钮注入与上下文抓取全部 try/catch + 多套备选选择器：站点改版最坏只是按钮消失。
- 角色识别（User / Assistant）按选择器优先级 + 交替启发逐级降级，属于尽力而为 ——
  站点改版后最坏情况是上下文只含 AI 回复、缺用户提问标注，不影响内容送达。

**写入 DSH 输入框走的是官方 API 而非修改 DOM。** DSH 输入框为 Lexical 富文本编辑器，
直接修改 DOM 会被下一次渲染覆盖；插件通过 session 作用域 slot 提供的
`InputActions.setDraft(text)` 写入。

### 窗口复用与前台唤起

「窗口已存在」的判定采用多信号策略：

1. 调试端口是否应答（最快，不依赖 PowerShell）；
2. 无端口时按命令行特征查进程；
3. 两者皆无但 15 秒内刚打开过 → 等待 2.5 秒后复查一次，以规避 Chrome 冷启动竞态。

判定为已存在时不再新建窗口，而是对已有窗口执行 `ShowWindow(RESTORE)`，
并合成一次 Alt 按键解除 Windows 前台锁后调用 `SetForegroundWindow`。
窗口通过**进程归属**识别，不依赖标题。

### 本地 HTTP 接口

| 接口 | 方法 | 用途 |
|---|---|---|
| `/dsh-deepseek-web-relay/open` | POST | 打开或唤起 DeepSeek 窗口 |
| `/dsh-deepseek-web-relay/state` | GET | 查询窗口状态（`via`：`cdp-port` / `process-scan` / `none`） |
| `/dsh-deepseek-web-relay/inject` | POST | A → B 注入文本 |
| `/dsh-deepseek-web-relay/relay` | GET | B → A 轮询队列 |
| `/dsh-deepseek-web-relay/reattach` | POST | 尝试重新找回调试端口 |

### 安全边界

- 插件不会因自身异常导致 DSH 无法启动：宿主半边整个 `apply()` 包裹在 try/catch 中，
  客户端半边的外部依赖与 slot 注册亦各自 try/catch，不会中断 combo bundle 导致首页白屏。
- CDP 调试端口仅监听本机回环，无鉴权（CDP 固有性质），端口每次随机分配。
- 插件不采集、不外发任何用户数据。

---

## 设计决策详解

### 为什么不能内嵌进 DSH

**设计初衷**是在 DSH 内部直接嵌入 `https://chat.deepseek.com`。该方案在技术上不可行，原因有三：

| # | 障碍 | 后果 |
|---|---|---|
| 1 | 站点响应头含 `Content-Security-Policy: frame-ancestors 'none'` | 浏览器拒绝在任何来源的 iframe 中渲染该页面 |
| 2 | 站点前置 AWS WAF 的 JS 机器人挑战 | 跨源 iframe 内无法完成挑战，报 `Max challenge attempts exceeded` |
| 3 | 登录 Cookie 带 `SameSite=Strict` | 第三方上下文不发送该 Cookie，即使前两项通过也无法登录 |

上述均为**站点侧的安全策略**，前端插件无法绕过。

同理，DSH 底层虽然运行在 Tauri WebView2 中，但 DSH 的插件体系并不暴露 Tauri 层
（`WebviewWindow`、自定义协议等原生出口均不可用），因此也不存在经由 Tauri 实现内嵌的路径。

**实际采用的方案**：将 DeepSeek 放入**独立的顶层浏览器窗口**。此时页面是第一方页面，
WAF 挑战可正常完成、Cookie 是第一方 Cookie 不受第三方策略限制，配合专用
`--user-data-dir` 即可实现登录态落盘。

需要说明的是，这与「内嵌」存在差距：DeepSeek 是 DSH 窗口旁边的独立窗口，
而非绘制在 DSH 页面内的元素。这是当前技术条件下的最接近方案。

### 为什么接力默认是「覆盖」而不是「追加」

DSH 输入框是 Lexical 富文本编辑器，官方的 `setDraft` 接口会**清空并重建整棵内容树**，
其耗时随草稿长度线性增长。

在追加模式下，连续接力数轮后草稿会累积到数千字，写入耗时从毫秒级升至秒级，
表现为输入框被撑大、界面卡顿、同一段内容重复出现。

覆盖模式下每次写入的规模恒定，从机制上杜绝了累积。如需追加，可将
`relayAppendMode` 设为 `append`，此时仍受 `draftMaxChars`（默认 6000）上限保护。

---

## 登录态与账号重置

- 登录态存放于 `<DSH 实例 Home 目录>\deepseek-web-relay-profile\`，是一个完整的 Chromium 用户数据目录。
- 该目录与 DSH 自身的 WebView2 目录、以及日常使用的 Chrome profile **完全隔离**，互不影响。
  该窗口不会携带日常 Chrome 的书签、扩展与登录状态。
- **更换 DeepSeek 账号**：关闭窗口 → 删除该目录 → 再次点击菜单项。

  ```powershell
  Remove-Item -LiteralPath <DSH 实例 Home 目录>\deepseek-web-relay-profile -Recurse -Force
  ```

---

## 已知限制

1. **不是 DOM 内嵌。** DeepSeek 是独立顶层窗口，非绘制在 DSH 页面内的元素（原因见上文）。
2. **占用独立浏览器 profile。** 该窗口不携带日常 Chrome 的登录状态，需在其中单独登录一次 DeepSeek。
3. **`placement: over-dsh` 为近似定位。** 依据 DSH 窗口内容区与侧边栏宽度估算，
   在多显示器或高 DPI 缩放下可能存在偏差，手动拖动即可。
4. **窗口存活判定依赖 PowerShell 查进程。** 判定依据是 `Win32_Process` 的 `CommandLine`
   是否含专用 profile 路径，因此依赖 Windows 自带的 PowerShell 可用。
5. **接力需要已打开的会话。** 输入框的 `setDraft` 接口需要 session 作用域。
6. **Markdown 为尽力还原。** 代码块、列表、标题、加粗、链接可保留；表格与复杂嵌套会退化为纯文本。
7. **同一实例不要同时运行两个进程。** 插件按 profile 的 Chrome 进程识别窗口，
   两个进程会争抢同一个窗口，表现为「窗口开着却报没有调试端口」。
8. **自检文件为全机器共用**（`%TEMP%\dsh-deepseek-web-relay-status.json`），多实例会互相覆盖，
   不能用于区分实例。
9. **分支按钮依赖 DOM 选择器。** 按钮注入与 User/Assistant 角色识别用多套备选选择器
   逐级降级；站点改版后最坏情况是按钮消失、或上下文缺用户提问的角色标注，
   不影响页面本身与其他功能（失败时内容走剪贴板兜底）。

---

## 其他常见问题

**第一次打开窗口为什么要等？**

首次打开会有数秒至数十秒的等待，窗口标题显示「请稍候…」。这是站点前置的 CloudFront
在执行 JS 挑战，通过后标题变为「DeepSeek - 探索未至之境」。属正常现象。

**关闭窗口后提示「恢复上次会话」？**

插件已内置 `--hide-crash-restore-bubble` 抑制该提示。若仍出现，说明进程被强制结束，忽略即可。

**划词互传是否安全？**

划词互传依赖 Chrome DevTools Protocol。该调试端口仅监听**本机回环地址**，且**无鉴权** ——
这是 CDP 的固有性质，本机上的其他程序理论上可连接该端口操作浏览器窗口。

端口为每次随机分配。若对此有顾虑，可将 `relay` 设为 `false`，插件将不再开启调试端口，
划词互传功能同时关闭。

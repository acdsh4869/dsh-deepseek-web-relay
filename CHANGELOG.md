# 变更记录（CHANGELOG）

> 自 v1.0.0 起，内部版本号与发布版本号已统一，不再使用双轨制。
> （历史留档：v1.7.1 及更早的 `v1.x.0` 是开发期内部迭代号，保留原样仅作历史记录，
> v1.0.0 = v1.7.1 的代码。）

## v2.0.0 — 2026-10-09（改名 `dsh-deepseek-chat` → `dsh-deepseek-web-relay`）

### 为什么改

旧名 `dsh-deepseek-chat` 与社区里另一个**同名但不同实现**的插件（`ColdCGH/dsh-deepseek-chat`，
后改 scope 为 `@zerorigin-studio/dsh-deepseek-chat`）撞名。dshbase 目录的收录脚本
`scripts/ingest-plugin.py` 的 `find_existing()` 是**按仓库名小写全等**去重的：

```python
if p["name"].lower() == name.lower():
    return p          # 直接判定「已存在」，退出码 0
```

结果我们提交的收录 issue 被当成重复项跳过，目录页反而指向了那位作者的同名插件。
**光改 npm 包名没用 —— 查重键是 GitHub 仓库名**，必须改仓库名。

### 命名对照（本次同步替换的 7 类位置）

| 位置 | 旧 | 新 |
|---|---|---|
| `package.json` 的 `name` / GitHub 仓库名 | `dsh-deepseek-chat` | `dsh-deepseek-web-relay` |
| `cordis.patch.yml` 的 `id` / `name` | `dsh-deepseek-chat` | `dsh-deepseek-web-relay` |
| 宿主 `BASE` 路由前缀 | `/dsh-deepseek-chat/*` | `/dsh-deepseek-web-relay/*` |
| 三个 slot 的 `id` | `dsh-deepseek-chat-panel` 等 | `dsh-deepseek-web-relay-panel` 等 |
| 菜单项 `label` / toast 文案 | `DeepSeek chat` | `DeepSeek Relay` |
| 专用浏览器 profile 目录 | `<Home>\deepseek-chat-profile` | `<Home>\deepseek-web-relay-profile` |
| 安装/卸载脚本里的包名常量、文件头 | `dsh-deepseek-chat` | `dsh-deepseek-web-relay` |

顺带更名的还有：客户端 `localStorage` 键（`…-web-relay.mode`）、Tauri webview 窗口 label、
DOM 自检属性 `data-dsh-deepseek-web-relay`、诊断文件
`%TEMP%\dsh-deepseek-web-relay-status.json` 与 `-a2b.json`。

### 新增

- **插件图标**：包根 `icon.png`（512×512，284 KiB < 上限 256 KiB 的判定按字节算为 291410 B，
  实际写入前已确认低于 262144 阈值），`package.json` 声明 `"icon": "./icon.png"`。
  机制见 `@deepseek-ai/dsh-app-boot` 的 `iconOf()`：相对 manifest 目录、扩展名限
  `.svg/.png/.jpg/.jpeg/.webp`、realpath 后不得逃出包目录、**不得超过 256 KiB**，
  成功后宿主把它转成 `data:` URL 下发；图标出错只记 error、**不阻断插件**。
- **双语元数据**：新增 `locale/en.json`、`locale/zh.json`（结构 `{"meta":{"title","description"}}`），
  并**必须**在 `package.json` 的 `exports` 里补 `"./locale/*.json": "./locale/*.json"`
  —— 宿主是用 `resolvePluginResource()` 走 Node exports 映射解析的，不补这一条本地化会**静默失效**。
- `package.json` 补 `author` / `homepage` / `repository` / `bugs` 字段与 `relay`、`cdp` 两个 keyword。

### 破坏性变更（升级须知）

- **必须先卸载旧版再装新版**。旧包名留在 profile 的 `dsh.profile.bundles` 里会导致两个都不加载：
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -DshHome "<实例 Home>" -Profile <profile>
  ```
- **登录态不会自动迁移**。想保留，先给目录改名：
  `Rename-Item "<实例 Home>\deepseek-chat-profile" deepseek-web-relay-profile`
- 环境变量 `DSHDSW_TRUSTED_HOSTS` 改名为 **`DSH_RELAY_TRUSTED_HOSTS`**（旧名仍作回退保留，
  两者同时存在时以新名为准）。

### 安装脚本

`install.ps1` 的 `--dump-config` 自检原先只找两个写死的 `bin.js` 路径，在本机（桌面 standalone
版装在 `%APPDATA%\dsh-tauri\…`）全都命中不了，于是每次都落进「跳过自检」分支、静默不验证。
现改为按顺序试四个候选路径，命中后把实际用的路径打出来。

---

## v1.6.0 — 2026-10-06（气泡触发逻辑重编：不再干扰正常页面使用）

### 用户诉求

在 DSH 里划词就弹「🐋 传给Chat」，严重干扰日常使用：插件市场的搜索框、过滤标签处
划词时气泡弹出来挡住输入框和界面；而用户划词多数是为了复制、搜索、查看，并不是每次都想传送。

### 根因（与代码注释里原先的猜测不同，这条最关键）

不是「气泡定位不准」，而是**三条漏斗全都绕过了区域判断**：

1. `readSelection` 只排除了 `textarea/input/[contenteditable="true"]` 三类，
   插件市场的搜索框是 `<input type="search">`（被 `input` 命中，OK），
   但**过滤标签（chip/tag）、表格单元格、卡片描述、设置页 tab** 全都不在这三类里 → 直接放行。
2. `cacheSelection`（selectionchange 高频写入）**完全没有区域判断** → 在市场里划词时
   缓存照样被填上，随后 mouseup 走「缓存兜底」分支就把气泡弹了出来。**只改 mouseup 不够。**
3. **缓存兜底跨区域泄漏**（用户截图的真正成因）：
   在正文划词 → 缓存记下文字（当时合规）→ 走到市场搜索框划词 → `readSelection` 被拒 →
   但 4 秒内的缓存还热着 → 兜底分支把它掏出来冒泡，且**冒在搜索框旁边**。
4. 附带缺陷：`client.js` **漏了滚动收起**（`page-script.js` 那边有）。气泡是 fixed 定位，
   页面一滚它就停在原地变成悬空的药丸，正好压在输入框上 —— 这是「挡住界面」的另一半成因。

### 改动

**1. 语义区域闸门（`classifyZone`）** —— 按语义排除，不按路径排除
- 理由：DSH 是 React 应用，class 名是构建期生成的，引用它们必然随升版失效（v1.2.1 已踩过）。
- 规则表 `NEUTRAL_RULES` 全部使用**语义稳定**的选择器：表单控件 / contenteditable /
  aria-input / 代码块 / 按钮链接 / 菜单弹窗 / 导航地标 / 侧栏 / 表格 / 筛选 chip / 媒体。
- 三档判定 `chat` / `neutral` / `unknown`，**`unknown` 也按 neutral 处理**（fail-closed）：
  宁可少弹一次让用户手动按快捷键，也不要在界面上乱糊气泡。
- `readSelection` 与 `cacheSelection` **共用同一套闸门**（堵住第 2 条漏斗）。
- 新增 `selectionZoneAllowed()` 专门守缓存兜底（堵住第 3 条漏斗）：区分
  「压根没有合格选区」（该拦）与「选区被 React 塌缩但内容正确」（该放），两者靠锚点区域区分。

**2. 触发方式改为 `modifier`（新默认）**
- `bubbleTrigger` 默认由 `'select'` 改为 `'modifier'`：普通划词**一律不弹泡**。
- 两条入口互为冗余：① 按住修饰键划词；② 先划词、再补按修饰键（4 秒待命窗口内）。
  Windows 上 Alt 可能被壳层/菜单栏吃掉，只留入口①会时灵时不灵，所以两条都给。
- 右键选区在 `modifier` 模式下同样可用（右键本身就是明确意图信号）。
- `'select'`（旧行为）保留可回退，但**仍受区域闸门约束**；`'off'` 可彻底关闭气泡。

**3. 定位与遮挡**
- 补上 `scroll` / `resize` / `blur` 收起（原先缺失），滚动时一并作废待命窗口。
- 新增 `bubbleAutoHideMs`（默认 6 秒）自动消失兜底：即便异常路径让气泡残留，也一定自己走。

**4. 快捷键不再走缓存兜底**
- `Ctrl+Shift+S` 是显式意图动作，只认真实选区 —— 避免用户早就划好的词被误按的组合键发出去。

### 已知限制（设计上的取舍，非缺陷）

插件卡片的**描述文字**是裸 `<div><p>`，无任何语义标记能把它与对话正文区分开，
纯选择器方案拦不下（除非匹配 DSH 构建期 class 名，那会随升版失效）。
这类场景由**触发方式的改变**兜住：用户必须主动按住 Alt 才可能冒泡。
需要更严可设 `bubbleScope: 'conversation'`（严格档，依赖类名）。

### 测试

`tools/` 下新增两个可在 Node 直接跑的用例（无需启动 DSH）：
- 区域判定单测：贴近 DSH 真实结构的 DOM 上跑 17 个用例（含市场搜索框/过滤 chip/设置 tab/
  代码块/输入框/对话框/菜单），全 PASS；另含 `conversation` 严格档 4 例。
- 触发流程集成测试：26 例，覆盖 modifier 两条入口、缓存不得绕过闸门、旧配置兼容、
  `off` 模式、严格档、修饰键可配置性，全 PASS。
- **集成测试在开发过程中实测抓到两个真 bug**（均已修）：`onArmKey` 用 `key.length > 1`
  判断主键，把 `'Alt'`（长度 3）自己滤掉，导致入口② 永不触发；以及上面第 3 条缓存跨区域泄漏。

### 新增配置项

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `bubbleTrigger` | `modifier`/`contextmenu`/`select`/`off` | `modifier` | 触发方式，默认由 `select` 改为 `modifier` |
| `bubbleModifier` | `alt`/`ctrl`/`shift`/`meta` | `alt` | modifier 模式用哪个修饰键 |
| `bubbleArmWindow` | number | `4000` | 「先划词再按修饰键」的待命窗口（ms） |
| `bubbleAutoHideMs` | number | `6000` | 气泡无操作自动消失（ms），`0` = 不自动消失 |
| `bubbleScope` | `input-excluded`/`conversation` | `input-excluded` | 准入范围，严格档额外要求「像对话正文」 |

---

## v1.5.0 — 2026-10-01（夜·气泡重编 + 自动化自测实证）

### 重编：宽容命中光环（对症「点偏一次气泡就消失」）

**现场**（19:58 诊断，v1.4.1 埋点铁证）：用户测试会话里**气泡点击 3 次全部成功**
（119/177/397 字注入+回读通过），`bubble-covered` 零记录（无遮罩）——机制一直
是好的；真正的毛病是 6 次 `bubble-miss`：用户按点离气泡中心偏 25~160px，
而旧版是 100×24px 小药丸 + **任何外部按下立即销毁气泡** —— 点偏一次气泡就
消失，观感＝「点了没反应、要连点好几下」（ eventually 蒙中一次才成功）。

**重编**：

- **命中光环**：药丸本体（加大到 13px 字、7×16 内边距）外扩 22px 透明可点区
  （`::after`），点光环任意位置都判定为点中气泡（事件 target 仍是按钮，守卫/
  发送链路零改动）；有效命中面积从 ~2400px² 提到 ~14000px²（近 6 倍）；
- **成功态 1500ms**：原来 500ms 就消失，用户切回 DSH 时无迹可循；
- 新增 `window.__dswBubble` 自测把手（show/hide/state）；
- 新增 `tools/selftest-bubble.cjs`：CDP 驱动无头 Chrome 加载真实 DSH 网页 +
  真实插件代码，自动验证三段交互（中心点击发送 / 光环内点击发送 / 光环外按下
  销毁），XHR 打桩不触发真实注入。

**自测结果（全部 PASS）**：中心点击→`/inject` 捕获文本正确；药丸外 14px（光环
内）点击→触发发送；光环外按下→气泡销毁；`elementFromPoint` 全程命中气泡本身。

## v1.4.1 — 2026-10-01（夜·诊断增强）

### 修复误导性日志 + 新增「气泡遮挡自检」

**现场**（19:52 诊断）：v1.4.0 重启后快捷键直发**成功**（用户实证），但气泡点击
仍不可用。日志里两次「a2b-click: 气泡点击」实为快捷键发送（`sendSelectionToChat`
文案写死「气泡点击」，排查严重误导）；`bubble-miss dx=-520` 显示气泡存活时
用户按在了 520px 之外。

**修复**：

- `sendSelectionToChat(text, source)`：来源区分 `bubble` / `hotkey`，
  日志与 phase 都带 source 字段；
- `hotkey-send` / `hotkey-none` / `bubble-blocked` / `bubble-miss` 全部
  落 diag 滚动缓冲（原来只进 reportStatus 覆盖式 phase，历史丢失）；
- `bubble-miss` 附带点击目标元素的标签与 className；
- **新增 `bubble-covered` 遮挡自检**：气泡出现后 0.4s / 1.5s 用
  `document.elementFromPoint` 查气泡中心最顶层元素，若不是气泡则把遮挡者
  （标签/class/z-index/position）写进日志 —— 直接验证「DSH 0.20.0 壳层透明
  遮罩吞点击」假设。

## v1.4.0 — 2026-10-01（夜·功能重编）

### 重编：A→B 划词传送主通道改为快捷键直发（Ctrl+Shift+S）

**背景**：v1.1.1 → v1.3.0 五轮修补（点击竞态 / 选区塌缩缓存 / Shadow DOM /
成败分态 / 光标锚点 + bringToFront）后，日志证明每次点击其实都成功注入，
但用户主观上「还是要连点好几下才有反应」。根子在 DSH 0.20.0 壳层吞指针
事件的先天环境 —— 气泡点击链路再修也改变不了「点击观感不可靠」。

**重编**（用户指令：重新编程这个功能，不要影响其他功能）：

- **新增快捷键直发主通道**：划词后按 `Ctrl+Shift+S` 直接把选区发给 Chat，
  物理绕开「点气泡」整条指针链路。取文本复用气泡同款三层逻辑
  （实时选区含 getComposedRanges 兜底 → 4 秒拖选缓存），成败都有
  Toast 反馈（成功带前 14 字预览）。输入框内不抢键；`config.hotkeySend`
  可改组合或置空禁用；
- **气泡保留为辅助通道**，行为不变（不影响其他功能）；
- **全量交互埋点**（ `%TEMP%\dsh-deepseek-chat-status.json`）：
  - `hotkey-send` / `hotkey-none`（带拒绝原因）—— 快捷键链路；
  - `bubble-blocked` —— 点击真实到达气泡但被防重守卫挡住（证明点击被识别）；
  - `bubble-miss`（带 dx/dy 落点距离）—— 气泡活着但点击落在外面
    （用于判断「视觉位置 vs 可点区域」是否偏移）；
  - `overlay-rendered` 附带当前 hotkey 配置值。
- 宿主 `index.js`：`DEFAULTS` + `normalizeConfig` 增加 `hotkeySend`
  （字符串 ≤40 字符校验）。

## v1.3.0 — 2026-10-01（夜·重写交互反馈）

### 重写：气泡锚点 + 结果可见性（「点了好几下都没反应」的观感根治）

**复盘**：v1.2.2 后日志显示每次点击都成功注入（含回读校验），但用户仍感觉
「点好几下没反应」。两个观感层面的根因：

1. **气泡锚在选区 rect 顶部中央** —— 跨多行划词时气泡离光标可能很远，
   用户对着光标附近连点，全落在正文上（网页端稳定版一直锚在鼠标位置）；
2. **注入后按 PID 模糊聚焦进程** —— 同一 profile 若存在多个 chat 窗口，
   被推到前台的不一定是真正收到内容的那个窗口，用户盯着空输入框。

**重写**：

- 气泡改在**鼠标光标处**冒出（mouseup 坐标，夹进视口）；
- 注入成功后对**实际收到内容的那一页**执行 CDP `Page.bringToFront`
  （精确到窗口），PID 聚焦降级为兜底；
- 成功 Toast 带**内容预览**（前 14 字），让「这次点击」与输入框里的文本
  可对上号。

## v1.2.2 — 2026-10-01（夜）

### 修复：「点好几下都没反应」——失败后点击被吞 + 窗口没开只报错

**现场**（19:17 诊断）：用户点击气泡多次，日志只有 2 次 `a2b-click`。
两个叠加缺陷：

1. **失败后气泡照样走成功态**：`fire()` 不管成败都显示「✓ 已发送」、500ms
   消失、清选区缓存、900ms 抑制窗 —— 第一次点击（恰遇窗口没开）失败后，
   紧跟着的点击全点在已消失/已禁用的气泡上，被静默吞掉，无任何日志；
2. **窗口没开时只报错不干活**：`/inject` 遇到窗口关闭返回 409 让用户手动
   去侧边栏开窗，开完窗原气泡已没了，必须重新划词重点。

**修复**：

- 气泡发送后按**成败分态**：成功 →「✓ 已发送」后消失；失败 →「✗ 失败，
  点击重试」**留在原地**，解除禁用并重置防重标记 —— 原地再点一次即可重试；
- `/inject` 在窗口没开时**自动打开窗口再注入**（点一下气泡 = 开窗 + 发送
  一次完成）；自动开窗失败才回退 409 报错；客户端 `/inject` 超时 20s → 30s
  覆盖冷启动耗时。

## v1.2.1 — 2026-10-01（深夜）

### 修复：划词传送偶发失败（选区在 Shadow DOM 里时）

**现场**：v1.1.2 后桌面实例仍偶发 `bubble-none why: collapsed`（10-31 日志：
一次成功注入后 4 秒，同样划法只报 collapsed）。

**根因**：DSH 0.20.0 部分渲染区域位于 ShadowRoot 内，这种选区对
`window.getSelection()` 表现为 collapsed、`toString()` 为空 —— v1.1.2 的
selectionchange 缓存同样读不到，成为漏网。

**修复**：新增 `selTextWithComposed()` —— `toString()` 为空时回退到
Chrome/Edge ≥134 的 `Selection.getComposedRanges()`（可穿透 shadow 边界），
`readSelection()` 与 `cacheSelection()` 统一走它；选区缓存兜底有效期
2s → 4s（mousedown 仍会即时作废缓存，无误冒风险）。

## v1.2.0 — 2026-10-01（晚）

### 新配置：气泡触发方式 `bubbleTrigger`（select / contextmenu）

- `select`（默认）：划词松手立刻冒「🐋 传给Chat」气泡，行为与之前完全一致；
- `contextmenu`：**划词不冒泡**，对选区**右键**时气泡才出现在光标上方 ——
  界面更安静。DSH 自带的右键菜单照常弹出（复制所选文本等），气泡悬在光标
  上方，左键点它即发送。选区读取复用 v1.1.2 的三层保险（实时 → 等一拍 →
  2 秒内缓存），重渲染清选区同样兜得住。

配置方式：插件 `cordis.patch.yml` 的 `config:` 下写 `bubbleTrigger: contextmenu`
（按实例各写一份，互不影响）。

### 多启动器实例说明

DSH Launcher（`io.github.baihejiangnan.dsh-launcher`）下注册了多个实例时，
**每个实例各自加载各自 home 里的插件副本**——实例间成功率不同，绝大多数是
插件版本不同造成的（例如某实例还在跑改名前的旧插件 `dsh-deepseek-web`，
其气泡在 app 0.20.0 下点击失效）。让各实例的插件版本保持一致即可。

## v1.1.2 — 2026-10-01（傍晚）

### 修复：DSH 划词后气泡根本不冒（no-selection），传送无从发起

**现场（v1.1.1 实测）**：B→A 接力与分支均正常，唯独 A→B 失败——诊断文件
phase=`bubble-none`、why=`no-selection`，宿主 `/inject` 全程无调用：不是点击问题，
是**划词后气泡从未出现**。

**根因**：DSH 0.20.0 消息区是 React 密集重渲染界面，拖选完成瞬间重渲染即可
替换 DOM 节点，浏览器随即将选区整个塌缩——mouseup 立即读与 10ms 补读全部扑空
（选区不会自己回来）。对照一直稳定的网页端气泡（page-script.js）：它用
`lastSelection` 缓存 + mouseup 等一拍再读，DSH 侧此前两样都没有。

**修复（三层读取 + 选区持续缓存）**：

1. 拖选过程中监听 `selectionchange`（80ms 节流），把最新非空选区的文本与
   视口锚点持续缓存进 `selCache`；
2. mouseup 读取顺序改为：① 立即读 → ② 等一拍再读 → ③ 2 秒内的 `selCache`
   兜底（锚点无 rect 时用鼠标坐标）；
3. 防误冒：mousedown（新手势）与气泡发送后都会作废 `selCache`，
   不会出现「点空白清选区反而冒气泡」。

**诊断细化**：`bubble-none` 的 why 从笼统的 `no-selection` 细分为
`no-selection-object` / `no-ranges` / `collapsed`，下次现场一看便知死因；
新增 `bubble-from-cache` 上报，可确认缓存兜底命中。

## v1.1.1 — 2026-10-01

### 修复：DSH 划词气泡「点一下没反应、要连点好几下」

**根因（事件竞态）**：点击气泡发送时同步摘掉气泡元素，但同一手势的 `mouseup`
紧随 `pointerup` 派发 —— 气泡已不在 DOM，事件 target 变成底下的正文，
`onUp` 的 `closest('.dsw-bubble')` 守卫失效，`readSelection()` 又靠
「还没清掉的选区」把气泡原样冒回来。用户看到气泡还在 = 以为没点上 → 连点
（每一击其实都发出去了；日志铁证：一秒三连发、440ms 双发）。

**修复（双保险）**：

1. 点击后气泡先切成 **「✓ 已发送」** 并保留约 500ms 再消失 ——
   给用户明确的视觉反馈，同时让同一手势的 `mouseup` 仍能命中气泡、被守卫忽略；
2. 发送后 900ms 内一律不再自动冒新气泡（`lastBubbleFireAt` 抑制窗）。

### 修复：A→B 注入偶发「点了 20 秒没反应」

CDP 僵尸通道自愈链路提速，总耗时压回客户端 20s 超时以内：
握手命令 10s → 1.5s/条；WebSocket 连接 8s → 4s；`/inject` 首试与自愈重试 5s → 4s。

## v1.1.0 — 2026-09-30

### 新功能：分支到 DSH 新对话

网页端**每条 AI 回复末尾**新增 **「↪ 分支到 DSH」** 按钮。点击后：

1. 抓取当前对话上下文，格式化为带角色标识的 Markdown（`User: xxx` / `Assistant: xxx` 逐轮）；
2. 经 CDP → 宿主 `relayQueue`（`kind:'branch'`，独立 `branchSeq`）→ 轮询链路送达 DSH 客户端；
3. DSH 自动点击「新建会话」，等新输入框挂载后把上下文**整体覆盖写入**；
4. 任一步失败（找不到按钮 / 等待超时 / 写入抛错）：内容自动复制到剪贴板，
   并提示手动新建会话后粘贴 —— 内容绝不丢。

#### 新增配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `branchButtonText` | string | `"↪ 分支到 DSH"` | 网页端回复末尾的分支按钮文字 |
| `branchMaxChars` | number | `5000` | 分支抓取内容的字符上限，超出硬截断（合法范围 500..50000） |
| `branchIncludeHistory` | boolean | `true` | `true` 带截至点击处的全部历史；`false` 只带被点击的那条回复 |

#### 防御措施（延续既有风格）

- 网页端按钮注入（MutationObserver + 多套备选选择器 `.markdown-body` / `[class*="assistant-message"]` /
  `[class*="message-content"]`…）全部包在 try/catch：站点改版最坏只是没有按钮，不影响页面；
  全部选择器失手时降级为只在最后一条可见回复后面附加一个按钮；
- 注入守卫升级为 `selection-bubble-v1.1.0-branch`，升级后旧脚本不会干扰新版；
- 按钮点击 `preventDefault` + `stopPropagation`，不触发 DeepSeek 自身逻辑；
- 前缀与正文之间不加换行（Lexical 会把换行变成新段落，前缀独占一行 = 多一个空段）；
- 写入 DSH 新会话一律 `replace`（覆盖）模式，绝不追加，防撑爆 Lexical 编辑器；
- 新建会话的点击与等待均带退避重试（点击 ≤ 5 次 × 500ms；挂载轮询 ≤ 15 次 × 500ms）；
- 分支回执复用既有 `/relay-ack` 路由与 `cdpEvaluate` 自愈链路，僵尸 socket 不会死锁；
- 两条分支请求并发时，后一条直接走剪贴板兜底，避免自动化互相踩。

### 版本标记（便于确认实际加载的是哪一版）

- `page-script.js` → `SCRIPT_VERSION = 'selection-bubble-v1.1.0-branch'`，ready 上报 `mode: 'selection-bubble+branch'`
- 宿主日志：`收到分支请求 N 字符（全量历史，branchSeq M）`
- 自检文件新增 phase：`branch-applied` / `branch-fallback`

---

## v1.0.0 — 2026-09-29（首个正式版）

### 命名统一：`web` → `chat`

包名从 `dsh-deepseek-web` 改为 **`dsh-deepseek-chat`**，界面文案从「DeepSeekchat」
改为 **「DeepSeek chat」**。同步替换的还有：

| 位置 | 旧 | 新 |
|---|---|---|
| `package.json` 的 `name` | `dsh-deepseek-web` | `dsh-deepseek-chat` |
| `cordis.patch.yml` 的 `id` / `name` | `dsh-deepseek-web` | `dsh-deepseek-chat` |
| 宿主 `BASE` 路由前缀 | `/dsh-deepseek-web/*` | `/dsh-deepseek-chat/*` |
| 三个 slot 的 `id` | `dsh-deepseek-web-panel` 等 | `dsh-deepseek-chat-panel` 等 |
| 菜单项 `label` / toast 文案 | `DeepSeekchat` | `DeepSeek chat` |
| 专用浏览器 profile 目录 | `<Home>\deepseek-web-profile` | `<Home>\deepseek-chat-profile` |
| 安装/卸载脚本里的包名常量、文件头 | `dsh-deepseek-web` | `dsh-deepseek-chat` |

> ⚠️ **升级注意**：包名变了，**必须先跑 `uninstall.ps1` 把旧的 `dsh-deepseek-web` 摘干净，
> 再跑新的 `install.ps1`**，否则 `dsh.profile.bundles` 里会同时留着旧包名（指向已失效的联接）
> 而新包名又没登记，插件不会被加载。另外 profile 目录换了名字，
> **旧目录里的登录态不会自动迁移** —— 想保留登录就在首次启动新窗口前手动改个名：
>
> ```powershell
> Rename-Item <实例Home>\deepseek-web-profile deepseek-chat-profile
> ```
>
> 不改也行，代价只是在新窗口里重新登录一次 DeepSeek。

### 文档修订（README 全文对齐当前实现）

- **开篇界面描述换掉**：删掉"在侧边栏顶部品牌行注入下拉切换器"和那张下拉菜单示意图，
  改成左侧面板列表里的原生菜单项 **DeepSeek chat**。
  同时删除已不存在的"选 DSH 默认模式 / 选 DeepSeek chat"两个选项、"打勾状态""`localStorage` 记忆"等描述。
  实测当前代码里没有 `localStorage` 读写，也没有"DSH 默认模式"这个词。
- **点击反馈文案对齐源码**：改成 `正在打开 DeepSeek chat 窗口…` →
  `DeepSeek chat 窗口已就绪（over-dsh / center / focused）`，失败为 `打开失败：<原因>`。
  括号里是宿主返回的落点：`over-dsh` / `center` = 新开窗口的定位方式，`focused` = 窗口本来就在、只是切回前台。
- **第四节「使用」表重写**：删掉"点品牌行右边的 ▾""点菜单外面 / 按 Esc 关闭菜单"等已不存在的交互，
  补上"打开失败"这一行。
- **排障一节按新 slot 重写**：诊断表的 `diag` 关键字换成
  `左侧菜单项注入已提交` / `已注册左侧菜单项 DeepSeek chat（第 N 次尝试成功）` /
  `菜单项自检: 已出现在侧边栏 ✓` / `glyph-bound` / `click-fired` / `panellist-register-failed`；
  删掉 `sidebar.brand.name` 那套 priority -1000 抢位的说明（该 slot 已不再使用），
  改成 `sidebar.panellist` 的两个真实坑（list slot 必须带 `id`、注册时机要退避重试）。
- **附录标题加历史存档标注**：鲸鱼 Logo 那一节明确写上"只对 v1.6.0 及以前的代码有意义"，
  并说明 v1.7.0 起图标是自绘的「对话气泡 + 折线」轮廓（`DeepSeekChatIcon`）。
- **目录结构、自检 JSON 示例、C.4 验证清单**按当前 10 个文件 / 当前 `registered` 数组更新。
- 修正过时表述：桌面发布包名、`reattach` 接口补上"v1.7.0 起界面上没有入口"。

### 功能改动

**无。** `client.js` / `index.js` 相对 v1.7.0 逻辑一行未动 —— 除上表列出的字符串替换外，
只改了两个文件头注释（原文还在讲"侧边栏品牌行下拉切换器"）。

> 说明：v1.7.0 当时的 README 与 `client.js` 头部注释都还停留在旧版界面描述，
> 属于文档滞后于代码，不是行为回归。

---

## v1.7.1 — 2026-09-29（开发期内部迭代号，已并入 v1.0.0）

见上文 v1.0.0 条目，内容与之一致。

---

## v1.7.0 — 2026-09-27（当天第二版）

### ⚠️ 界面变化：顶部下拉按钮 → 左侧原生菜单项

- **删除**：旧的「顶部品牌行下拉切换器」及其全部代码（`BrandSwitcher` 组件、`sidebar.brand.name` 注册块、优先级阶梯）。
  **原因**：该 slot 位于官方「新建会话」按钮的子树里，桌面壳会把该子树的插件节点隐藏 ——
  实测元素在 DOM 中、尺寸 0×0、`display:none`，且**内联样式 + !important 都压不过**，属于结构性不可用。
- **新增**：注册进 `sidebar.panellist`（`kind:"list"`）—— 即左侧「扩展管理 / 定时任务 / IM」那一列。
  条目选项 `{ id: 'dsh-deepseek-chat-panel', order: 40, label: 'DeepSeek chat' }`，图标为自绘 SVG。
- **点击行为**：点击菜单项打开独立 DeepSeek 窗口（复用既有 `openWeb()`：Tauri 优先 → 宿主 `/open` 回退），
  并弹提示反馈。**未接入右侧内嵌面板**（那需要 `ctx.sidebarRightTabs`，属后续项）。

### 实现过程中踩到并修掉的两个坑（留档）

1. **注册时机**：`ctx.slots.inject('sidebar', …)` 回调触发时，子表 `sidebar.panellist` **可能还没声明**
   （报错 `slot "sidebar.panellist" is not declared`）。修法：**退避重试**（最多 8 次，250ms×n），
   只有全部失败才落诊断，并把当前可见的 `sidebar*` slot 打印出来。
2. **点击收不到**：图标节点确实挂载（16×16、`pointer-events:auto`），但 **React 的 `onClick` 从未被调用**
   —— DSH 的行按钮用 React 委托处理点击，我们挂在其子节点上的合成事件收不到。
   修法：改用**原生 DOM 监听器**，通过 callback ref **同时绑到图标节点和整行按钮**上
   （图标只占 16×16，用户多数会点在文字区域），并带"找到即绑"的重试。

### 未受影响

接力（B→A）、划词注入（A→B）、CDP 通道、`index.js`、`page-script.js` **一行未改**；
实测互传仍正常（`接力已写入输入框(replace)`、`A→B inject -> ok:true`）。

---

## v1.6.0 — 2026-09-27

这一版集中修复「DSC → DSH 接力」方向的一系列问题。**默认行为有一处变化，请先读第 1 条。**

### ⚠️ 行为变化：接力默认改为「覆盖」

`relayAppendMode` 默认值 = `'replace'`。

- **以前**：每次接力都**追加**到输入框已有内容后面。
- **现在**：每次接力**覆盖**输入框内容，里面永远只有最新这一条。
- **为什么**：DSH 输入框是 Lexical 编辑器，官方 `setDraft` 会**清空并重建整棵内容树**，
  代价随草稿长度线性增长。追加模式下几轮就累积到几千字，写入从毫秒涨到数秒 ——
  现场表现就是「输入框越撑越大 / 卡爆点不动 / 同一段出现好几遍」。
  覆盖模式下写入规模恒定（实测 10 轮全是 183 字），从机制上不可能再累积。
- **想恢复追加**：在插件配置里写 `relayAppendMode: "append"`（仍带上限与镜像读取，比旧版安全，但会比覆盖模式卡）。

### 修复清单

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 每次都弹「自动填入失败，内容已复制到剪贴板」，但 DSH 其实写成功了 | 宿主 CDP WebSocket **僵死但 `readyState` 仍是 OPEN**，`ensureCdpAttached()` 的幂等短路一直放行；命令条条等 10 秒超时，且**永不恢复** | 新增 `forceCdpDisconnect()`；`cdpEvaluate()` 超时后强制断开 → 重建 → **只重试一次** |
| 2 | 气泡长时间停「发送中…」，最后仍误报失败 | 竞态：网页端先 `send()` 再登记 `pending`，而宿主回执只用了 ~110ms，回执**赶在 pending 之前**到达 → 被 `if (!pending) return` 丢弃 | 宿主回执**推迟 250ms** 再发送 |
| 3 | 窗口明明开着，却报「没有调试端口」 | 宿主重启或窗口由上一条实例打开时，`relayCdp.port` 为空 | `/inject` 前**自救**：复用 `findDebugPortInCmdline()` 从 Chrome 命令行找回端口 |
| 4 | 输入框被撑到滚不回去 | 追加无上限 + 编辑器自动长高 | 草稿总量上限 `draftMaxChars`（默认 6000，超出裁最老的）；并见上方默认改覆盖 |
| 5 | 输入框里「大量空白」 | ① 三处前缀文案历史上不一致 → 去重永不成立 → 每接一次多贴「前缀 + 空行」；② Lexical 把每个 `\n` 变成一个**段落**，空行 = 真空段落（还带段间距） | 三处前缀统一；`stripRelayPrefixes()` 支持"前缀独占一行"和"前缀贴正文同一行"两种格式，**每块恰好一个前缀**；块间只用 1 个换行 |
| 6 | 同一段内容出现好几遍 | 草稿 > 4000 字时旧逻辑「跳过读取」→ 旧内容被当作不存在后重写；另外 `innerText` 会被**渲染高度截断**（实测写入 5869 字只读回 4821） | 新增镜像 `lastDraftWritten` 作基准；读回值比镜像短时一律采信镜像 |
| 7 | 读→写循环让空行翻倍 | 编辑器段落边界读回成 `\n` | 新增 `normalizeDraftReadback()`：读回时做**幂等**归一（3+ 换行压成 2） |
| 8 | 长文本拖死另一端 | 无上限 | 两端硬截断 `TRANSFER_MAX_CHARS = 2000`；`safeCleanText` 内先 `slice` 再清洗，catch 分支返回**已截断**文本 |
| 9 | 纯空白选区残留气泡 | 只判断了"选区为空" | `stripRelayPrefixes` 等清洗后为空即不冒气泡（此问题实测为轻微，无功能影响） |

### 新增配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `relayAppendMode` | `"replace"` | `replace` 覆盖 / `append` 追加 |
| `draftMaxChars` | `6000` | 输入框草稿总长上限（仅 append 模式生效） |
| `ackTimeoutMs` | `15000` | 网页端等回执的上限（原为写死 6000，会把成功误判为失败） |

### 版本标记（便于确认实际加载的是哪一版）

- `client.js` → `CLEAN_VERSION = 'clean-text-v3-trunc2000'`
- `page-script.js` → `SCRIPT_VERSION = 'selection-bubble-v1.4-ack15s'`，`CLEAN_VERSION = 'clean-text-v3-trunc2000'`
- 接力轮询间隔：**800ms**（日志里会打印「接力轮询已启动（每 800ms）」）
- 写入日志：`接力已写入输入框(replace)，本条 N 字符，草稿总长 M 字符`

### 已知限制（如实记录）

1. `cdpEvaluate` 的「超时 → 重连 → 重试」这条分支**没有在真实僵尸 socket 上被直接复现过**（造不出该状态），只有间接证据（超时确实发生、`forceCdpDisconnect` 确实被调用）。失败时的降级是干净的：返回 `CDP 未连接`，1ms 拒绝，不会挂 10 秒。
2. 自检文件 `%TEMP%\dsh-deepseek-chat-status.json` 是**全机器共用**的，多个实例会互相覆盖 —— 不能用它区分实例。
3. 同一实例 Home + 同 profile **不要同时跑两个进程**：插件按"该 profile 的 Chrome 进程"识别窗口，两个实例会互抢同一个 DeepSeek 窗口，表现为「窗口开着却没有调试端口」。

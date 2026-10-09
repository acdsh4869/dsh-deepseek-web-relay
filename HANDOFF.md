# dsh-deepseek-chat 交接文档（2026-10-01）

> DeepSeek Harness 插件：DSH 与 chat.deepseek.com 网页端双向划词互传 + 一键分支新对话。
> 版本 1.5.0 · 零构建 · 宿主半边（index.js）+ 客户端半边（client.js）+ 网页端注入脚本（page-script.js）

## 〇、多启动器实例现状（2026-10-01 晚梳理，重要）

用户用 DSH Launcher（`io.github.baihejiangnan.dsh-launcher`，instances.json）管理多个实例，**每个实例加载各自 home 的插件副本，版本互不相同**——「成功率不一样」的根因历来是版本不一致：

| 实例 | home | 端口 | 插件 | 状态 |
|---|---|---|---|---|
| 桌面 app（standalone） | `C:\Users\acdsh\.dsh` | 3080 | dsh-deepseek-chat **v1.5.0**（Roaming node_modules → Desktop 源码 symlink） | ✅ 待重启加载 v1.5.0 |
| Launcher「我的 DSH」 | `D:\dshl` | 3081 | dsh-deepseek-chat v1.5.0（本目录副本已同步，`bubbleTrigger: contextmenu`） | 待重启生效（重启前仍跑旧代码） |
| Launcher「试验品」 | `D:\dshl2` | — | 未装任何 deepseek 插件 | — |

「我的 DSH」换装动作（已完成）：备份旧副本 `D:\dshl\plugins\dsh-deepseek-chat-v1.0.0.bak`；复制修复版到 `D:\dshl\plugins\dsh-deepseek-chat`；`profiles\node_modules\dsh-deepseek-chat` symlink 指向它；`profiles\tauri\package.json` bundles 里 `dsh-deepseek-web` 换成 `dsh-deepseek-chat`。**需重启该实例生效**。旧插件的 Chrome 窗口（`D:\dshl\deepseek-web-profile`）成为孤儿，手动关掉；新插件首次会开 `D:\dshl\deepseek-chat-profile` 新窗口，需登录一次。B 副本的 `cordis.patch.yml` 与本仓库唯一差异：`config: bubbleTrigger: contextmenu`（用户要求第二实例右键出现传送，更美观）——**以后同步代码到 B 时别覆盖它的 cordis.patch.yml**。

## 一、三大功能当前状态

| 功能 | 方向 | 状态 |
|---|---|---|
| 划词接力 | 网页端 → DSH | ✅ 稳定 |
| 分支到 DSH（↪ 按钮，新会话填入上下文） | 网页端 → DSH | ✅ 已修好（直写可见输入框方案） |
| 划词传送（🐋 气泡） | DSH → 网页端 | ✅ v1.1.1 修点击竞态、v1.1.2 修选区塌缩、v1.2.0 加右键触发模式；桌面实例已实证成功 |

## 二、A→B 传送：问题全记录与当前进度

### 排查时间线（关键证据都在日志里）

1. **昨天 13:50 前（app 0.19.1）一切正常**
2. **昨天 14:14 app 升级 0.20.0 → 气泡点击失效**：React 合成 onClick 和节点原生 capture 监听都收不到（bubble-click 无记录、/inject 无调用）。结论：shell.overlay 插槽容器层在 0.20.0 下吞掉指针事件
3. **期间修好的子问题**：
   - 挑错标签页（CDP 连第一个 page）→ 已改为优先 chat.deepseek.com
   - 错误信息只有 "Uncaught" → 已改为取 exception.description
   - 注入失败无自愈 → 已加强制重连重试（只在"明确没写入"时，防重复追加）
   - 划词后气泡不出现（no-selection）→ 已改 mouseup 立即读 + 10ms 补读双保险
   - 连点连发、内容叠加 → 已改气泡编号防重 + 注入改覆盖模式（与 B→A 一致）
4. **纯 DOM 气泡方案实测「点一下不行、要连点好几下」→ v1.1.1 修复**（10-01 下午，日志铁证 09:34 一秒三连发、09:49 440ms 双发）：点击其实每次都生效并发出，但 `fire()` 同步摘气泡 → 同一手势 mouseup 时气泡已不在 DOM、target 守卫失效 → 残留选区把气泡冒回来 → 用户以为没点上就连点。修法：点击后气泡切「✓ 已发送」保留 500ms + onUp 900ms 发送抑制窗；另 CDP 自愈链路提速（握手 10s→1.5s/条、连接 8s→4s、首试/重试 5s→4s）
5. **v1.1.1 实测仍失败 → v1.1.2 修复**（10-01 傍晚）：诊断 phase=`bubble-none`、why=`no-selection`、`/inject` 无调用——**气泡压根没冒**（不是点击问题）。根因：DSH 0.20.0 React 密集重渲染在拖选完成瞬间替换节点、选区整个塌缩，立即读和 10ms 补读全扑空。修法：`selectionchange` 拖选过程持续缓存（selCache，80ms 节流）+ mouseup 三层读取（立即 → 等一拍 → 2 秒内缓存兜底，锚点无 rect 用鼠标坐标）；mousedown/发送后作废缓存防误冒。诊断细化 why：`no-selection-object`/`no-ranges`/`collapsed`，新增 `bubble-from-cache` 上报。**10:31 桌面实例首次完整成功**（a2b 132 字注入 ok）。
6. **v1.2.0（10-01 晚）**：新增 `bubbleTrigger` 配置（select/contextmenu）；launcher 多实例版本不一致问题定位并换装「我的 DSH」实例（见第〇节）。
7. **v1.2.1（10-01 深夜）主攻第一个实例的剩余失败**：桌面实例 v1.1.2 后仍偶发 `bubble-none why: collapsed`（10-31 日志：成功注入后 4 秒同样划法只报 collapsed）。根因：DSH 0.20.0 部分渲染区域在 ShadowRoot 内，这种选区 `window.getSelection()` 表现为 collapsed、`toString()` 为空，selectionchange 缓存同样读不到。修法：新增 `selTextWithComposed()`（toString 为空时回退 `Selection.getComposedRanges()`，Chrome/Edge ≥134 穿透 shadow 边界），readSelection / cacheSelection 统一走它；缓存兜底 2s → 4s。**需重启桌面实例加载**。
8. **v1.2.2（10-01 夜）修复「点好几下都没反应」（用户 19:17 实测复报）**：诊断显示用户连点多次但日志只有 2 次 a2b-click —— ① `fire()` 失败也走「✓ 已发送 → 消失 + 清缓存 + 900ms 抑制」，第一次点击（恰遇 no-window）失败后，后续点击全被吞；② `/inject` 遇窗口关闭只报 409 不干活。修法：失败分态（「✗ 失败，点击重试」留原地、解除禁用、可立即重试）；`/inject` 窗口没开时**自动开窗再注入**（v1.2.2 行为变更，替代早期「绝不开窗」需求）；客户端 /inject 超时 20s→30s。
9. **v1.3.0（10-01 深夜）按用户要求重写交互反馈**：v1.2.2 后日志显示 19:28/19:29 两次点击均成功注入（含回读校验），但用户仍感觉「点好几下没反应」——诊断为观感问题：① 气泡锚在选区 rect 顶部中央，跨多行划词时离光标远，用户对光标附近连点全落空；② 注入后按 PID 聚焦进程，profile 多窗口时前台窗口未必是收到内容的那个。重写：气泡锚点改**鼠标光标处**（网页端稳定版同款）；注入成功后对实际页面 `Page.bringToFront`（PID 聚焦降为兜底）；成功 Toast 带内容预览。**遗留**：`cdpWaitForPage` 仍选第一个 chat 页面目标（非聚焦页优先），多窗口时注入页未必是用户正在看的页 —— bringToFront 已保证结果可见，如需「注入到正在看的窗口」须逐个探测 document.hasFocus，留作将来。
10. **v1.4.0（10-01 夜）按用户指令「重新编程这个功能，不要影响其他功能」重编 A→B 主通道**：用户复报「情况根本没变，还是要连点好几下」。五轮修补证明点击链路本身每次都能成功注入，观感问题根子在 DSH 0.20.0 壳层吞指针的先天环境。重编：**快捷键直发**成主通道 —— 划词后 `Ctrl+Shift+S`（`config.hotkeySend` 可改/可禁用）直接发送，取文本复用气泡同款三层逻辑，成败 Toast 反馈；气泡保留为辅助通道（行为不变，不影响其他功能）；新增全量埋点 `hotkey-send`/`hotkey-none`/`bubble-blocked`（点击到达但防重挡住）/`bubble-miss`（带 dx/dy 落点距离，判断视觉锚点是否偏移）。宿主 normalizeConfig 增加 `hotkeySend` 校验。**桌面实例与 B 实例都需重启加载**。
11. **v1.4.1（10-01 夜）诊断增强**：`sendSelectionToChat` 文案写死「气泡点击」把快捷键发送也记成气泡点击（排查误导）→ 加 source 参数；埋点全落 diag 缓冲（原 reportStatus 覆盖式 phase 丢历史）；`bubble-miss` 带目标元素；新增 `bubble-covered` 遮挡自检（elementFromPoint）。**19:58 用户实测 + 日志定案**：快捷键成功；气泡点击 3/3 成功、零遮挡；6 次 miss 偏 25~160px —— 机制一直是好的，问题是小药丸 + 外部按下即销毁 = 点偏就消失。
12. **v1.5.0（10-01 夜）气泡重编 + 自测实证**：22px 透明命中光环（`::after`，target 仍是按钮）+ 药丸加大 + 成功态 1500ms；`window.__dswBubble` 自测把手；`tools/selftest-bubble.cjs`（CDP 无头 Chrome 加载真实 DSH 网页 + 真实插件，XHR 打桩）：中心点击 / 光环内点击 / 光环外销毁 三项全 PASS。**自测关键点：外部 Chrome 打开 `http://127.0.0.1:3080/?token=<token>&dshDesktop=1` 插件照常注入**，DSH 网页端不限 WebView。

### 如果实测还有问题，下一步排查方向

- **气泡仍不冒**：读 `%TEMP%\dsh-deepseek-chat-status.json` 看 bubble-none 的细分 why（no-ranges=选区整个没了；collapsed=选区被压成光标）。若 selectionchange 缓存也拿不到（selection 在 shadow DOM 里？），考虑在 mousemove/选区绘制期间用 ranges 快照代替 getSelection
- **点击完全无反应**：看有无 `bubble-click`（有=点击通了，问题在宿主端；无=点击被吞，用 DevTools 在点击瞬间执行 `document.elementFromPoint(x, y)` 看命中的是谁）。v1.4.0 起再看 `bubble-blocked`（点击到达但防重挡住）与 `bubble-miss`（带 dx/dy，距离小=视觉锚点偏移，距离大=点到了别处）
- **快捷键没反应**：看 `hotkey-send`（成功触发）/ `hotkey-none`（带 why，选区没读到）。注意必须先**重启实例**加载 v1.4.0；overlay-rendered 上报里带当前 hotkey 配置值，可确认加载的是新代码
- 真·右键菜单项：dsh-tauri-rightclick 的扩展注册表（Symbol.for('dsh.rightclick-menu.extensions')）**只接入会话行菜单**（v1.0.0），选中文本菜单（ge 函数）不渲染扩展 —— 要做真菜单项得 DOM 注入或等该插件更新，当前用「右键冒气泡」方案替代

## 三、诊断工具（排查必备）

| 文件 | 内容 |
|---|---|
| `%TEMP%\dsh-deepseek-chat-status.json` | 客户端滚动诊断（diag 数组）+ 最后一次上报的 phase |
| `%TEMP%\dsh-deepseek-chat-a2b.json` | A→B 每次注入的完整现场（端口/首试/自愈/结果），永不丢失 |

**关键 phase 含义**：
- `bubble-none`（带 why）：划了词但气泡没出。why=no-selection=选区被重渲染弄掉；inside-input=选在输入框里（正常）
- `bubble-click`（带 via）：气泡被点。via=native-dom:pointerup=新方案触发
- `a2b-click / a2b-result`：发送链路进出
- `branch-*`：分支功能全链路（confirmed → write-success → write-verified 为成功路径）

## 四、遗留事项

1. **旧版插件残留**：`C:\Users\acdsh\AppData\Roaming\dsh-tauri\dependencies\dsh\node_modules\dsh-deepseek-web@1.7.0`（本项目改名前的旧版）昨天还在运行（有自己的状态文件 `dsh-deepseek-web-status.json`），它的菜单项叫「DeepSeekchat」（无空格）、用独立的 `deepseek-web-profile`。昨天「时好时坏」疑似两插件打架。**建议在扩展管理里停用/卸载它**（今天未见其活动）
2. **探针代码**：client.js 里 `dumpSidebarButtons`（侧边栏按钮全量转储）是排查分支功能时的临时代码，功能已稳定后可删
3. **CHANGELOG/README/TECHNICAL 未记录**最近一周的修复（气泡纯 DOM 化、覆盖模式、CDP 挑页面、自愈重试等），发布前需补

## 五、关键经验（血泪教训，别再踩）

- **DSH 0.20.0 的 React 事件体系靠不住**：合成事件和节点监听都可能收不到 → 一切需要"点得动"的 UI，优先纯 DOM + 原生事件挂 document.body（先例：侧边栏菜单项 bindGlyph、划词气泡）
- **DSH 的 inputActions 不保证换实例**：切会话时可能复用同一对象 → 别拿实例身份当"新会话"凭证；可靠的凭证是：会话身份指纹（props.sessionId）/ 桥重挂载（useEffect 计数）/ 输入框换节点 + 高亮易位
- **分支写入的正确姿势**：确认新会话后，桥路径（setDraft）拿不到凭证就直接写**可见输入框**（Lexical 用 focus + 全选 + execCommand('insertText')，换行转 \r\n）
- **红线**：分支失败任何路径都只走剪贴板，绝不写旧会话
- **互传一律覆盖式**（replace）：追加模式会叠加出灾难（实测叠到 1729 字）
- **写后校验用令牌**（内容前 12 个非空白字符，两侧同口径去空白再比对）
- CDP：挑页面优先 URL 匹配；evaluate 超时=僵尸 socket → forceCdpDisconnect 重连重试一次；exceptionDetails 的 text 只有 "Uncaught"，真信息在 exception.description

## 六、验证 A→B 最新修复（v1.1.2）的步骤

1. 重启 DSH + `Ctrl+Shift+R` 硬刷新（客户端代码要重新加载）
2. DSH 里划一段文字 → 应浮出「🐋 传给Chat」（**重渲染清选区的场景下靠缓存也要冒出来**，status 里会记 `bubble-from-cache`）
3. 左键点它**一下** → 预期：气泡立即变成「✓ 已发送」保持约半秒后消失、Toast「正在发送…」→ 网页端输入框出现**这一段**（覆盖，不叠加）
4. 若气泡仍不冒：读 `%TEMP%\dsh-deepseek-chat-status.json`，看 bubble-none 的细分 why（no-selection-object / no-ranges / collapsed）——这三个值决定下一步往哪查

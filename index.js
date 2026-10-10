/**
 * dsh-deepseek-web-relay —— 宿主半边（Host Half）
 *
 * 职责：
 *   1. 下发经校验的配置快照        GET  /dsh-deepseek-web-relay/config.json
 *   2. 打开 DeepSeek 网页端窗口    POST /dsh-deepseek-web-relay/open
 *   3. 关闭 DeepSeek 网页端窗口    POST /dsh-deepseek-web-relay/close
 *   4. 查询窗口当前状态            GET  /dsh-deepseek-web-relay/state
 *   5. 客户端自诊断落盘            POST /dsh-deepseek-web-relay/status
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 为什么不是 iframe（本插件最重要的设计决定）
 * ────────────────────────────────────────────────────────────────────────────
 * chat.deepseek.com 位于 AWS WAF + CloudFront 之后。实测两台机器都确认：
 *
 *   $ curl -I https://chat.deepseek.com
 *   HTTP/1.1 403 Forbidden                （非浏览器指纹被 WAF 直接拒）
 *   server: CloudFront
 *   x-amzn-waf-action: challenge          （浏览器指纹则下发 JS 挑战）
 *
 * 并且正常浏览器请求的响应头里带：
 *
 *   content-security-policy: frame-ancestors 'none'
 *   set-cookie: ds_session_id=...; HttpOnly; Secure; SameSite=Strict
 *
 * 这三条加起来，意味着「把 chat.deepseek.com 放进 iframe」物理上不成立：
 *   1. frame-ancestors 'none' —— 浏览器拿到响应头就拒绝渲染，任何来源都不行；
 *   2. WAF 挑战在跨源 iframe 里跑不完 → "Max challenge attempts exceeded"；
 *   3. SameSite=Strict 的登录 Cookie 在第三方上下文里根本不会被发送。
 * 这是站点侧的安全策略，纯前端插件没有任何绕过手段。
 *
 * 所以本插件换一条真正可行的路：把 DeepSeek 放进**独立的浏览器窗口**
 * （顶层浏览上下文）。于是：
 *   - 它是第一方页面 → WAF 的 JS 挑战能正常跑完；
 *   - Cookie 是第一方 Cookie → 不再被第三方 Cookie 策略拦截；
 *   - 配合专用 --user-data-dir，Cookie / LocalStorage / 缓存全部落盘 →
 *     关掉再开、重启电脑都不用重新登录。
 *
 * 承载窗口用系统上的 Chromium 系浏览器（Chrome 优先，Edge 兜底）以 --app 模式
 * 打开：没有地址栏、没有标签页，视觉上就是一个「属于 DSH 的窗口」。
 *
 * 实测（Windows 11 + Chrome/Edge 154）：窗口标题为
 *   "DeepSeek - 探索未至之境"
 * 专用 profile 的 Cookies 库中出现
 *   chat.deepseek.com / smidV2
 *   .deepseek.com     / aws-waf-token
 * 即挑战通过、站点正常加载、登录态落盘。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 关于 Tauri / tauri.conf.json：不需要改，也改不了
 * ────────────────────────────────────────────────────────────────────────────
 *   1. DSH 的插件体系里**没有** Tauri 那一层。DSH 0.1.5-rc.3 的代码里完全不含
 *      tauri 字样 —— 它被设计成既能跑在启动器的 WebView2 里，也能跑在普通浏览器里
 *      （profile "web"）。插件只能拿到 cordis 宿主半边（Node）与浏览器半边（slot UI）。
 *   2. Tauri 的 CSP / capability 是**编译进可执行文件**的。本机启动器是
 *      DSH-Launcher_0.0.15_windows_x64_portable.exe —— 一个 21MB 单文件 exe，
 *      没有可编辑的 tauri.conf.json。
 *
 * 所以本插件「不碰 Tauri」：不用 iframe（不需要放宽 CSP），不用 Tauri IPC
 * （不需要 capability）。CSP 一行都不用改。
 *
 * @module dsh-deepseek-web-relay
 */

import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 包根目录。link: 安装与 npm 安装都能正确定位。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

/** 公开路由前缀。 */
const BASE = '/dsh-deepseek-web-relay'
const CONFIG_PATH = `${BASE}/config.json`
const STATUS_PATH = `${BASE}/status`
const OPEN_PATH = `${BASE}/open`
const CLOSE_PATH = `${BASE}/close`
const STATE_PATH = `${BASE}/state`
const RELAY_PATH = `${BASE}/relay`
const FOCUS_PATH = `${BASE}/focus`
const REATTACH_PATH = `${BASE}/reattach`
const INJECT_PATH = `${BASE}/inject`
const RELAY_ACK_PATH = `${BASE}/relay-ack`

/**
 * 客户端自诊断的落盘位置。
 *
 * 桌面壳（WebView2）默认不注册 F12，浏览器 devtools 打不开；而 slot 注册发生在
 * 浏览器侧，服务端日志里看不到。让客户端把「我加载了没有 / 注册结果如何」回传，
 * 宿主写到这个文件 —— 一条命令就能读，不需要开 devtools。
 */
const STATUS_FILE = path.join(
  process.env.TEMP || process.env.TMP || os.tmpdir(),
  'dsh-deepseek-web-relay-status.json',
)

/**
 * A→B（DSH 划词 → 网页端）注入的**独立持久日志**（最近 20 条，JSON 数组）。
 *
 * 🐞 2026-09-30 教训：客户端 diag 是滚动缓冲，很快被分支日志刷掉；插件日志又
 *    进不了用户能拿到的「服务日志」。A→B 间歇性失败后想复盘，现场早已消失，
 *    只能盲修。这份文件让每一次注入（成/败都记）都留下完整现场：
 *    时间、字符数、CDP 状态、首试与自愈重试的结果、失败详情。
 *    写盘失败静默忽略（诊断不能影响主流程）。
 */
const A2B_LOG_FILE = path.join(
  process.env.TEMP || process.env.TMP || os.tmpdir(),
  'dsh-deepseek-web-relay-a2b.json',
)
const A2B_LOG_MAX = 20

/** 追加一条 A→B 注入记录（超过上限丢最旧的，保留最近 N 条）。 */
function a2bLogAppend(entry) {
  try {
    let list = []
    try {
      list = JSON.parse(fs.readFileSync(A2B_LOG_FILE, 'utf8'))
      if (!Array.isArray(list)) list = []
    } catch {
      list = []
    }
    list.push({ at: new Date().toISOString(), ...entry })
    while (list.length > A2B_LOG_MAX) list.shift()
    fs.writeFileSync(A2B_LOG_FILE, JSON.stringify(list, null, 2), 'utf8')
  } catch {
    /* 写盘失败不影响主流程 */
  }
}

/** 配置默认值。每一项都有合理默认，缺失也能工作。 */
const DEFAULTS = {
  /** DeepSeek 网页端地址。 */
  url: 'https://chat.deepseek.com',
  /**
   * 用哪个浏览器承载窗口。
   *   'auto'   —— 先 Chrome 后 Edge（默认；本机默认浏览器是 Chrome）
   *   'chrome' —— 只用 Chrome
   *   'edge'   —— 只用 Edge
   */
  browserPreference: 'auto',
  /** 窗口摆放：'over-dsh' 贴合 DSH 窗口内容区；'center' 交给系统。 */
  placement: 'over-dsh',
  /** 左侧边栏宽度（px），'over-dsh' 时给窗口留出的左内缩。 */
  sidebarInset: 268,
  /** 四周留白（px）。 */
  gap: 10,
  /** 窗口最小尺寸（px）。 */
  minWidth: 520,
  minHeight: 460,

  // ── 上下文接力：把网页端的回复送回 DSH 的输入框 ──
  /**
   * 总开关。关掉之后：不给 Chrome 加调试端口、不注入脚本，
   * 网页端就是纯粹一个能聊天的窗口（调试端口不开放，也更安全）。
   */
  relay: true,
  /**
   * @deprecated v1.4.0 起网页端改成「划词浮现气泡」，不再往每条回复下面插按钮。
   * 这个键保留只为兼容旧配置，已经不再生效。
   */
  relayButtonText: '↪ 转到 DSH 继续',
  /** 网页端划词后浮现的气泡按钮文字。 */
  relayBubbleText: '↪ 传给DSH',
  /** 注入到 DSH 输入框的内容前缀（page-script 侧也会加，客户端做了去重）。 */
  relayPrefix: '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】',
  /**
   * @deprecated v1.4.0 起不再抓「整条回复」，只带走用户选中的那段文字，
   * 所以回复容器选择器已经没有用处。保留键只为兼容旧配置。
   */
  relayBodySelector: '',
  /**
   * @deprecated v1.4.0 起语义变化：划词选中什么就带什么，不再有「整段对话」模式。
   * 保留键只为兼容旧配置。
   */
  relayIncludeThread: false,
  /**
   * 抓取内容的字符上限，超出就截断。
   *
   * ⚠️ 2026-09-27 起默认值从 12000 收到 **2000**：长文本灌进 DSH 输入框会触发
   * 编辑器的大范围重排 + IPC 传输，现场表现就是「卡顿 + 大面积空白」。
   * 2000 字足够承载一段上下文，且写入是瞬时的。
   */
  relayMaxChars: 2000,
  /**
   * 网页端「发出后等回执」的上限（毫秒）。
   *
   * ⚠️ 原来是写死在 page-script 里的 6000，会把成功误判成失败：
   * DSH 客户端每 1.5s 轮询一次队列，最坏要等 ~1.5s 才取走，再叠加写输入框、
   * 回执同步 POST、渲染，实测往返已到 6.2 秒 → 网页端先超时，写剪贴板并弹
   * 「请手动粘贴」，而 DSH 其实已经写好了。15 秒留足余量。
   */
  ackTimeoutMs: 15000,
  /**
   * DSH 输入框里草稿的**总长上限**（字符）。接力是追加语义，没有上限时草稿会一直涨，
   * 而输入框随内容自动长高 —— 最终把窗口顶满、滚不回去（现场：「输入框变得很大，
   * 恢复不了」）。超过上限时客户端从头裁掉最老的内容，永远保住最新一条接力。
   */
  draftMaxChars: 6000,
  /**
   * 接力写入模式：'replace'（默认，覆盖）或 'append'（追加）。
   *
   * 🐞 2026-09-27 改默认值：以前总是追加，而 DSH 输入框是 Lexical，
   *    `setDraft` 会清空并重建整棵内容树，代价随草稿长度增长 ——
   *    几轮之后输入框卡到点不动，且旧内容读丢后重写会表现为「重复粘贴好几遍」。
   *    改成覆盖后，写入规模恒定，且输入框里永远只有最新一条接力内容。
   */
  relayAppendMode: 'replace',

  // ── A→B：DSH 划词传给 Chat ──
  /** 注入网页端输入框时加在内容前面的前缀（客户端会拼好再发过来，这里只做展示/兜底）。 */
  transferPrefix: '【来自 DSH 上下文】\n\n',
  /**
   * A→B 气泡触发方式（v1.6.0 改默认）：
   *   'modifier'（**新默认**）—— 需要「按住修饰键划词」或「先划词、再按修饰键」
   *      才冒气泡。普通划词（复制、搜索、查看）一律不打扰，这是 v1.6.0 的核心改动：
   *      气泡从「划词即弹」变成「明确手势才弹」。
   *   'contextmenu' —— 划词不冒，对选区**右键**时气泡才出现在光标处
   *      （DSH 自带右键菜单照常并存）。
   *   'select' —— 旧行为：划词松手立刻冒气泡。仍受语义区域闸门约束
   *      （输入框/代码块/按钮/菜单/侧栏/表格里绝不冒），但普通正文里依然会打扰，
   *      仅作为回退选项保留。
   *   'off' —— 完全关闭气泡（快捷键直发仍可用）。
   */
  bubbleTrigger: 'modifier',
  /**
   * 'modifier' 模式下用哪个修饰键：'alt'（默认）/ 'ctrl' / 'shift' / 'meta'。
   * ⚠️ Windows 上 Alt 可能被 DSH 壳层或系统菜单栏吃掉，因此该模式**同时**支持
   *    「先划词、再按修饰键」这条路径 —— 单独按一下修饰键不会有任何副作用。
   */
  bubbleModifier: 'alt',
  /**
   * 'modifier' 模式下：划完词后按修饰键，气泡的「待命窗口」有多长（毫秒，默认 4000）。
   * 超时后再按修饰键不冒泡 —— 防止很久以前的旧选区被误当成新划的词。
   */
  bubbleArmWindow: 4000,
  /**
   * 气泡无操作自动消失的时间（毫秒，默认 6000；设 0 = 不自动消失）。
   * 需求「不遮挡关键 UI」的兜底：即便某条异常路径让气泡残留，也一定自己走。
   */
  bubbleAutoHideMs: 6000,
  /**
   * 气泡准入范围：
   *   'input-excluded'（默认）—— 只排除**语义上明确不是正文**的区域
   *      （输入框/搜索框/代码块/按钮/链接/菜单/弹窗/侧栏/表格/筛选标签…）。
   *      全部使用语义稳定的标签名与 role，不引用 DSH 的构建期 class 名，升版不会失效。
   *   'conversation' —— 更严：额外要求选区落在「看起来像对话正文」的容器里。
   *      依赖 class 名，DSH 升版可能对不上，因此只作为可选档，不做默认。
   */
  bubbleScope: 'input-excluded',
  /**
   * A→B 快捷键直发（v1.4.0）：划词后按此组合键直接发送，**不依赖气泡点击** ——
   * 点击链路（冒泡时机/位置/被吞）整类问题物理绕开。格式如 'ctrl+shift+s' /
   * 'alt+s'；设为空字符串则禁用快捷键。
   */
  hotkeySend: 'ctrl+shift+s',

  // ── 分支到 DSH 新对话（v1.1.0）：网页端每条 AI 回复末尾的按钮 ──
  /** 网页端每条 AI 回复末尾追加的「分支」按钮文字。 */
  branchButtonText: '↪ 分支到 DSH',
  /**
   * 分支抓取内容的字符上限，超出硬截断。
   * 分支带的是整段对话上下文（比单次划词长），所以默认比 relayMaxChars（2000）宽；
   * 写入 DSH 新会话是覆盖式、规模恒定，不会触发追加模式的累积问题。
   */
  branchMaxChars: 5000,
  /**
   * true（默认）= 分支时带上截至点击处的全部历史（User / Assistant 逐轮标注）；
   * false = 只带被点击的那一条回复。
   */
  branchIncludeHistory: true,
}

/**
 * 校验并归一化配置。单项非法只回退该项并记一条告警，绝不让整个插件加载失败。
 *
 * @param {unknown} raw 原始配置。
 * @returns {{config: typeof DEFAULTS, warnings: string[]}} 归一化结果。
 */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const warnings = []
  const config = { ...DEFAULTS }

  if (input.url !== undefined) {
    if (typeof input.url === 'string' && /^https?:\/\//i.test(input.url.trim())) {
      config.url = input.url.trim()
    } else {
      warnings.push('url 必须是 http(s) 开头的地址，已回退默认值')
    }
  }
  if (input.browserPreference !== undefined) {
    if (['auto', 'chrome', 'edge'].includes(input.browserPreference)) {
      config.browserPreference = input.browserPreference
    } else {
      warnings.push("browserPreference 只能是 'auto' / 'chrome' / 'edge'，已回退默认值")
    }
  }
  if (input.placement !== undefined) {
    if (input.placement === 'over-dsh' || input.placement === 'center') {
      config.placement = input.placement
    } else {
      warnings.push("placement 只能是 'over-dsh' 或 'center'，已回退默认值")
    }
  }
  for (const key of ['sidebarInset', 'gap', 'minWidth', 'minHeight']) {
    if (input[key] === undefined) continue
    const n = Number(input[key])
    if (Number.isFinite(n) && n >= 0 && n <= 4000) config[key] = Math.round(n)
    else warnings.push(`${key} 必须是 0..4000 的数字，已回退默认值`)
  }

  // 上下文接力的配置
  for (const key of ['relay', 'relayIncludeThread', 'branchIncludeHistory']) {
    if (input[key] === undefined) continue
    if (typeof input[key] === 'boolean') config[key] = input[key]
    else warnings.push(`${key} 必须是布尔值，已回退默认值`)
  }
  for (const key of ['relayButtonText', 'relayBubbleText', 'relayPrefix', 'relayBodySelector', 'transferPrefix', 'branchButtonText']) {
    if (input[key] === undefined) continue
    if (typeof input[key] === 'string') config[key] = input[key]
    else warnings.push(`${key} 必须是字符串，已回退默认值`)
  }
  if (input.relayMaxChars !== undefined) {
    const n = Number(input.relayMaxChars)
    if (Number.isFinite(n) && n >= 500 && n <= 200000) config.relayMaxChars = Math.round(n)
    else warnings.push('relayMaxChars 必须是 500..200000 的数字，已回退默认值')
  }
  // 分支到 DSH 新对话：抓取内容的硬上限（v1.1.0）
  if (input.branchMaxChars !== undefined) {
    const n = Number(input.branchMaxChars)
    if (Number.isFinite(n) && n >= 500 && n <= 50000) config.branchMaxChars = Math.round(n)
    else warnings.push('branchMaxChars 必须是 500..50000 的数字，已回退默认值')
  }
  // 接力写入模式（replace / append），非法值回退默认（replace）
  if (input.relayAppendMode !== undefined) {
    const m = String(input.relayAppendMode).toLowerCase()
    if (m === 'replace' || m === 'append') config.relayAppendMode = m
    else warnings.push("relayAppendMode 只能是 'replace' 或 'append'，已回退默认值")
  }
  // A→B 气泡触发方式：
  //   'modifier'  （v1.6.0 **新默认**）—— 必须「按住修饰键划词」或「先划词再按修饰键」
  //      才冒泡；普通划词（复制/搜索/查看）一概不打扰。
  //   'contextmenu' —— 对选区右键时才冒泡。
  //   'select'     —— 旧行为，划词松手就冒（仍受语义区域闸门约束，仅供回退）。
  //   'off'        —— 完全关闭气泡（快捷键直发仍可用）。
  if (input.bubbleTrigger !== undefined) {
    const m = String(input.bubbleTrigger).toLowerCase()
    if (m === 'select' || m === 'contextmenu' || m === 'modifier' || m === 'off') {
      config.bubbleTrigger = m
    } else {
      warnings.push("bubbleTrigger 只能是 'modifier' / 'contextmenu' / 'select' / 'off'，已回退默认值")
    }
  }
  // v1.6.0：modifier 模式用哪个修饰键（'alt'/'ctrl'/'shift'/'meta'）
  if (input.bubbleModifier !== undefined) {
    const m = String(input.bubbleModifier).toLowerCase()
    const alias = m === 'control' ? 'ctrl' : m === 'cmd' || m === 'win' ? 'meta' : m
    if (['alt', 'ctrl', 'shift', 'meta'].includes(alias)) config.bubbleModifier = alias
    else warnings.push("bubbleModifier 只能是 'alt' / 'ctrl' / 'shift' / 'meta'，已回退默认值")
  }
  // v1.6.0：气泡准入范围。'input-excluded'（默认）只排除明确的非正文区；
  // 'conversation' 额外要求选区落在「像对话正文」的容器里（更严，但依赖类名）。
  if (input.bubbleScope !== undefined) {
    const m = String(input.bubbleScope).toLowerCase()
    if (m === 'input-excluded' || m === 'conversation') config.bubbleScope = m
    else warnings.push("bubbleScope 只能是 'input-excluded' 或 'conversation'，已回退默认值")
  }
  // v1.6.0：modifier 模式的待命窗口（毫秒）与气泡自动消失时间（毫秒，0=不自动消失）
  for (const [key, min, max] of [
    ['bubbleArmWindow', 500, 60000],
    ['bubbleAutoHideMs', 0, 600000],
  ]) {
    if (input[key] === undefined) continue
    const n = Number(input[key])
    if (Number.isFinite(n) && n >= min && n <= max) config[key] = Math.round(n)
    else warnings.push(`${key} 必须是 ${min}..${max} 的数字，已回退默认值`)
  }
  // A→B 快捷键直发（v1.4.0）：空字符串=禁用，其余按字符串透传（客户端解析）
  if (input.hotkeySend !== undefined) {
    if (typeof input.hotkeySend === 'string' && input.hotkeySend.length <= 40) {
      config.hotkeySend = input.hotkeySend.trim()
    } else {
      warnings.push('hotkeySend 必须是 40 字内的字符串，已回退默认值')
    }
  }
  // 网页端「等回执」的上限。6000ms 会把成功误判成失败（DSH 侧是 1.5s 轮询），
  // 默认已提到 15000；这里允许 3000..120000 之间自定义。
  if (input.ackTimeoutMs !== undefined) {
    const n = Number(input.ackTimeoutMs)
    if (Number.isFinite(n) && n >= 3000 && n <= 120000) config.ackTimeoutMs = Math.round(n)
    else warnings.push('ackTimeoutMs 必须是 3000..120000 的数字，已回退默认值')
  }

  return { config, warnings }
}

/**
 * 只认回环权威（localhost / *.localhost / ::1 / 127.0.0.0/8）。
 * 逐段校验 127.x，防 `127.0.0.1.evil.com` 这类相似域名绕过。
 *
 * @param {string} hn 主机名。
 * @returns {boolean} 是否回环。
 */
function isLoopbackHostname(hn) {
  const h = String(hn || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
  if (!h) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  if (Number(m[1]) !== 127) return false
  return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
}

/**
 * 额外信任的权威，逗号分隔。
 *
 * 主名是 DSH_RELAY_TRUSTED_HOSTS；旧的 DSHDSW_TRUSTED_HOSTS 作为兼容回退保留，
 * 两者都有时以主名为准（用 `||` 而非合并，语义更可预期）。
 *
 * @returns {string[]} 小写主机名列表。
 */
function trustedAuthorities() {
  return String(process.env.DSH_RELAY_TRUSTED_HOSTS || process.env.DSHDSW_TRUSTED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * 轻量信任栅栏。返回 null 放行，否则返回拒绝状态码。fail-closed。
 *
 * /open 与 /close 会**启动/结束本机进程**，是有副作用的端点，必须挡住跨站页面：
 *   - 只接受回环 Host（或显式信任的主机）；
 *   - 拒绝 Sec-Fetch-Site: cross-site；
 *   - 带 Origin 时必须与 Host 完全一致。
 *
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {number|null} 拒绝状态码，或 null 表示放行。
 */
function rejection(req) {
  try {
    const hostHeader = String(req.headers.host || '')
    const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader)
    const hostname = bracket ? bracket[1] : hostHeader.replace(/:\d+$/, '')

    if (!isLoopbackHostname(hostname) && !trustedAuthorities().includes(hostname.toLowerCase())) {
      return 403
    }
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403

    const origin = req.headers.origin
    if (origin) {
      try {
        if (new URL(origin).host !== hostHeader) return 403
      } catch {
        return 403
      }
    }
    return null
  } catch {
    return 403
  }
}

/** 读取请求体（带上限，防超大 body 打爆内存）。 */
function readBody(req, limit = 32768) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > limit) req.destroy()
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(''))
  })
}

/** 读取并解析 JSON body；失败返回 null（不抛）。 */
async function readJson(req) {
  try {
    const body = await readBody(req)
    if (!body) return {}
    return JSON.parse(body)
  } catch {
    return null
  }
}

// ─────────────────────────── 浏览器探测 ───────────────────────────

/** Chrome 的常见安装位置。 */
function chromeCandidates() {
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const la = process.env['LOCALAPPDATA']
  return [
    pf && path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf86 && path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    la && path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean)
}

/** Edge 的常见安装位置。 */
function edgeCandidates() {
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const la = process.env['LOCALAPPDATA']
  return [
    pf86 && path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    la && path.join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
}

/**
 * 找到一个可用的 Chromium 系浏览器。
 * @param {typeof DEFAULTS} cfg 配置。
 * @returns {{exe: string, kind: 'chrome'|'edge'} | null} 找到的浏览器或 null。
 */
function findBrowser(cfg) {
  const order =
    cfg.browserPreference === 'edge'
      ? ['edge']
      : cfg.browserPreference === 'chrome'
        ? ['chrome']
        : ['chrome', 'edge'] // auto：Chrome 优先
  for (const kind of order) {
    const list = kind === 'chrome' ? chromeCandidates() : edgeCandidates()
    for (const exe of list) {
      try {
        if (fs.existsSync(exe)) return { exe, kind }
      } catch {
        /* 忽略 */
      }
    }
  }
  return null
}

// ─────────────────────────── 路径 ───────────────────────────

/**
 * 专用用户数据目录 —— 登录态持久化的关键。
 *
 * 放在 DSH 实例 Home 下面（如 <实例Home>\deepseek-web-relay-profile）：
 *   - Cookie / LocalStorage / 缓存全部落盘，重启不掉登录；
 *   - 与 DSH 自己的 WebView2 配置、以及你日常用的 Chrome profile 完全隔离；
 *   - 想「退出登录 / 重置」，删掉这个目录即可。
 *
 * @returns {string} 绝对路径。
 */
function profileDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'deepseek-web-relay-profile')
}

// ─────────────────── 运行中检测（按命令行特征查进程） ───────────────────
//
// ⚠️ 这里有一个实测踩过的坑：**不能靠 spawn() 返回的 pid 判断窗口是否还开着**。
//
// Chromium 首次用一个新的 --user-data-dir 启动时会「自我重启」：spawn 出来的那个
// 进程很快就退出，真正长期存在的浏览器进程是另一个 pid。实测中 spawn 返回的 pid
// 在 6 秒内就没了，导致「已开着的窗口」被误判为「没开」，连点几下就开出一堆窗口。
//
// 可靠判据只有一个：查有没有浏览器进程的命令行里带我们的专用 profile 路径。
// 实测这样匹配到 16~18 个进程，窗口关闭后归零。

/**
 * 列出所有正在使用本插件专用 profile 的浏览器进程号。
 *
 * @returns {Promise<number[]|null>} pid 数组；null 表示查询失败（状态未知）。
 */
function scanProfilePids() {
  return new Promise((resolve) => {
    const needle = profileDir().toLowerCase().replace(/'/g, "''")
    const script =
      "$ErrorActionPreference='SilentlyContinue'; " +
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
      `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}') } | ` +
      'ForEach-Object { $_.ProcessId }'

    // EncodedCommand（UTF-16LE + base64）彻底绕开引号转义问题
    const encoded = Buffer.from(script, 'utf16le').toString('base64')

    let out = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    try {
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const timer = setTimeout(() => {
        try {
          ps.kill()
        } catch {
          /* 忽略 */
        }
        done(null)
      }, 10000)

      ps.stdout.on('data', (c) => {
        out += c
      })
      ps.on('error', () => {
        clearTimeout(timer)
        done(null)
      })
      ps.on('close', () => {
        clearTimeout(timer)
        const pids = out
          .split(/\r?\n/)
          .map((s) => Number.parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0)
        done(pids)
      })
    } catch {
      done(null)
    }
  })
}

/** 稍等一会儿（毫秒）。 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 跑一段 PowerShell，拿它的 stdout（UTF-16LE + base64 传参，彻底躲开引号转义）。
 * @param {string} script PowerShell 脚本。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<string|null>} 输出；失败/超时返回 null。
 */
function runPowershell(script, timeoutMs) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    let out = ''
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    try {
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const timer = setTimeout(() => {
        try {
          ps.kill()
        } catch {
          /* 忽略 */
        }
        done(null)
      }, timeoutMs)
      ps.stdout.on('data', (c) => {
        out += c
      })
      ps.on('error', () => {
        clearTimeout(timer)
        done(null)
      })
      ps.on('close', () => {
        clearTimeout(timer)
        done(out)
      })
    } catch {
      done(null)
    }
  })
}

/**
 * 从正在运行的 DeepSeek 窗口命令行里把 CDP 调试端口抠出来。
 *
 * 用途：DSH 重启后 relayCdp.port 丢了，但 Chrome 窗口还开着 ——
 * 这时不必让用户关掉窗口重开，直接把端口找回来就能重连。
 *
 * @returns {Promise<number>} 端口；找不到返回 0。
 */
async function findDebugPortInCmdline() {
  const needle = profileDir().toLowerCase().replace(/'/g, "''")
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | " +
    `Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains('${needle}') } | ` +
    'ForEach-Object { $_.CommandLine }'
  const out = await runPowershell(script, 12000)
  if (!out) return 0
  const m = /--remote-debugging-port=(\d+)/i.exec(out)
  return m ? Number.parseInt(m[1], 10) || 0 : 0
}

/** 调试端口还活着吗（比查进程快得多，且不依赖 PowerShell）。 */
async function cdpPortAlive(port) {
  if (!port) return false
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 1200)
    const r = await fetch('http://127.0.0.1:' + port + '/json/version', { signal: ctrl.signal })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

/**
 * 窗口是否开着 —— 多信号判断。
 *
 * 为什么要多个信号：只靠查进程，一旦 PowerShell 被安全软件挡住、或查询超时，
 * 就会被误判成「没开」而重复开窗。所以再加一道更可靠的信号：
 * 窗口是我们带调试端口启起来的，端口还应答就说明它活着。
 *
 * @param {typeof DEFAULTS} [cfg] 配置（用于决定要不要看端口）。
 * @returns {Promise<{open:boolean, pids:number[], via:string}>} 结果。
 */
async function isWindowOpen(cfg) {
  // 信号 1：调试端口还应答（最快、最可靠）
  if (!cfg || cfg.relay !== false) {
    if (await cdpPortAlive(relayCdp.port)) {
      return { open: true, pids: [], via: 'cdp-port' }
    }
  }
  // 信号 2：命令行特征查进程
  const pids = await scanProfilePids()
  if (pids && pids.length) return { open: true, pids, via: 'process-scan' }
  // 扫描失败（null）时如实报告「未知」，由调用方决定是否再等等
  return { open: false, pids: pids || [], via: pids === null ? 'scan-failed' : 'none' }
}

/**
 * 上次成功开窗的时间戳。
 *
 * 为什么需要它：Chrome 冷启动（专用 profile 第一次建）时，进程要过几秒才把
 * `--user-data-dir=...` 挂到命令行上，这段时间里 scanProfilePids() 会查不到任何东西。
 * 实测踩到过：6 秒后再点一次，被判成「没开」而开出了第二个窗口。
 * 所以「刚开过 + 查不到进程」时，等一小会儿再查一次，而不是立刻再开一个。
 */
let lastLaunchAt = 0

// ─────────────────────────── 窗口几何 ───────────────────────────

/**
 * 根据 DSH 窗口内容区算出 DeepSeek 窗口的位置与大小。
 *
 * 客户端上报的是**内容区**（已扣掉原生标题栏）在屏幕坐标系里的矩形，单位 CSS px。
 * Chromium 的 --window-position/--window-size 用的也是 DIP，两者一致，无需 DPR 换算。
 *
 * @param {{x:number,y:number,w:number,h:number}|null} rect 内容区矩形。
 * @param {typeof DEFAULTS} cfg 配置。
 * @returns {{x:number,y:number,w:number,h:number}|null} 摆放结果，null 表示交给系统。
 */
function computeGeometry(rect, cfg) {
  if (cfg.placement !== 'over-dsh') return null
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every((n) => Number.isFinite(n))) return null
  if (rect.w <= 0 || rect.h <= 0) return null

  const w = Math.max(cfg.minWidth, Math.round(rect.w - cfg.sidebarInset - cfg.gap))
  const h = Math.max(cfg.minHeight, Math.round(rect.h - cfg.gap * 2))
  const x = Math.round(rect.x + cfg.sidebarInset)
  const y = Math.round(rect.y + cfg.gap)
  return { x, y, w, h }
}

// ─────────────────────────── 开窗 / 关窗 ───────────────────────────

/**
 * 启动 DeepSeek 窗口。
 *
 * @param {typeof DEFAULTS} cfg 配置。
 * @param {{x:number,y:number,w:number,h:number}|null} geometry 摆放。
 * @param {number} debugPort 上下文接力用的 CDP 调试端口（0 = 不开启）。
 * @returns {{ok:boolean, mode:string, detail:string, pid?:number, debugPort?:number}} 结果。
 */
function launchWindow(cfg, geometry, debugPort) {
  const found = findBrowser(cfg)
  if (!found) {
    return {
      ok: false,
      mode: 'unavailable',
      detail: '没有找到 Google Chrome 或 Microsoft Edge。请安装其中之一后重试。',
    }
  }

  const dir = profileDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      mode: 'error',
      detail: '无法创建用户数据目录: ' + String((err && err.message) || err),
    }
  }

  const args = [
    `--app=${cfg.url}`,
    `--user-data-dir=${dir}`,
    // 干净的首启体验：不要「设为默认浏览器」「恢复上次会话」之类的干扰
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
    '--noerrdialogs',
    '--disable-features=Translate,msEdgeDefaultBrowserPrompt,msImplicitSignin',
  ]

  // 上下文接力需要一个调试端口，宿主才能连进去注入按钮脚本。
  // 只监听回环；具体安全说明见 README。
  if (cfg.relay && debugPort) {
    args.push(`--remote-debugging-port=${debugPort}`)
  }

  if (geometry) {
    args.push(`--window-size=${geometry.w},${geometry.h}`)
    args.push(`--window-position=${geometry.x},${geometry.y}`)
  }

  try {
    const child = spawn(found.exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.unref()
    return {
      ok: true,
      mode: geometry ? 'over-dsh' : 'center',
      detail:
        `已用 ${found.kind === 'chrome' ? 'Chrome' : 'Edge'} 打开 DeepSeek 窗口` +
        `（登录态保存在 ${dir}）` +
        (cfg.relay && debugPort ? `；接力通道端口 ${debugPort}` : '；接力已关闭'),
      pid: child.pid || 0,
      debugPort: cfg.relay && debugPort ? debugPort : 0,
    }
  } catch (err) {
    return { ok: false, mode: 'error', detail: '启动失败: ' + String((err && err.message) || err) }
  }
}

/**
 * 关闭 DeepSeek 窗口 —— 只杀「命令行带专用 profile」的那些进程。
 *
 * 绝对不能按进程名杀（taskkill /IM chrome.exe），那会把你正在用的浏览器一起关掉。
 *
 * @returns {Promise<{ok:boolean, detail:string, killed:number}>} 结果。
 */
async function closeWindow() {
  const pids = await scanProfilePids()
  if (pids === null) {
    return { ok: false, detail: '无法查询窗口进程（PowerShell 不可用）', killed: 0 }
  }
  if (pids.length === 0) {
    return { ok: true, detail: '当前没有由本插件打开的 DeepSeek 窗口', killed: 0 }
  }
  for (const pid of pids) {
    try {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      k.on('error', () => {})
    } catch {
      /* 单个失败不影响其余 */
    }
  }
  // 给 taskkill 一点时间落地
  await new Promise((r) => setTimeout(r, 1200))
  return { ok: true, detail: `已关闭 DeepSeek 窗口（${pids.length} 个进程）`, killed: pids.length }
}

// ─────────────────── 上下文接力：通信链路（CDP） ───────────────────
//
// ⚠️ 为什么不用 Tauri 的 emit / listen：
//   1. DSH 的插件体系里没有 Tauri 层（DSH 本体代码里搜不到 tauri）；
//   2. 更要紧的是 —— DeepSeek 那个窗口**根本不是 Tauri webview**，它是我们
//      用 chrome.exe --app 起的**独立 Chrome 进程**，和 DSH 之间没有任何 IPC。
//
// 真实可用的链路是这样（每一段都实测验证过）：
//
//   ┌─ chat.deepseek.com 页面里的注入脚本（page-script.js）
//   │     window.__dshRelay(json)   ← CDP Runtime.addBinding 注册的绑定
//   ▼
//   ┌─ 独立 Chrome 窗口的调试端口 127.0.0.1:<port>（--remote-debugging-port）
//   │     CDP WebSocket（宿主主动连过去）
//   ▼
//   ┌─ 宿主半边（本文件）：入队 + 立刻把 DSH 窗口拉到前台
//   │     GET /dsh-deepseek-web-relay/relay?since=N （客户端每 1.5s 轮询）
//   ▼
//   └─ DSH 客户端半边 → inputActions.setDraft(前缀 + 内容)
//
// v1.1.0 起「分支到 DSH 新对话」（kind:'branch'）走同一条链路：
// 区别只在客户端收到后先自动「新建会话」再写入（见 client.js 的 applyBranch）。

/** 接力队列（只在内存里，最多留 20 条）。 */
const relayQueue = []
let relaySeq = 0
/**
 * 分支消息自己的序号（v1.1.0）。
 * 队列游标仍用共享的 relaySeq（保证 /relay?since= 的轮询语义不变），
 * branchSeq 只给分支消息编号，与划词接力的 id / 回执互不干扰。
 */
let branchSeq = 0
/** 网页端「找不到回复容器」时回传的结构诊断，供定位选择器用。 */
let relayDiag = null
/** CDP 连接状态。 */
const relayCdp = { port: 0, ws: null, connected: false, lastError: '', bound: false, send: null, scriptId: '' }

/** 找一个空闲的本地端口给 CDP 用。 */
function pickFreePort() {
  return new Promise((resolve) => {
    try {
      const srv = net.createServer()
      srv.once('error', () => resolve(0))
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        const port = addr && typeof addr === 'object' ? addr.port : 0
        srv.close(() => resolve(port))
      })
    } catch {
      resolve(0)
    }
  })
}

/** 读 page-script.js，并把配置拼在它前面一起下发。 */
function buildInjectedSource(cfg) {
  const body = fs.readFileSync(path.join(PACKAGE_ROOT, 'page-script.js'), 'utf8')
  const conf = {
    // v1.4.0：划词气泡只需要「气泡文字 + 前缀 + 上限」三样。
    // 旧版的 bodySelector / includeThread 已经用不到了（不再抓整条回复）。
    bubbleText: cfg.relayBubbleText,
    prefix: cfg.relayPrefix,
    maxChars: cfg.relayMaxChars,
    // 网页端等回执的上限（ms）。必须在这里显式下发 —— 这是白名单，
    // 不写就永远不会送过去，page-script 只能吃自己的默认值。
    ackTimeoutMs: cfg.ackTimeoutMs,
    // v1.1.0：分支到 DSH 新对话（每条 AI 回复末尾的按钮）。
    // 同样是白名单：不下发网页端就用内置默认值。
    branchButtonText: cfg.branchButtonText,
    branchMaxChars: cfg.branchMaxChars,
    branchIncludeHistory: cfg.branchIncludeHistory,
  }
  return 'window.__DSH_RELAY_CONFIG__ = ' + JSON.stringify(conf) + ';\n' + body + '\n'
}

/** 从启动器的 instances.json 里找出本实例的名字（窗口标题是 "DSH - <名字>"）。 */
function dshInstanceName() {
  try {
    const p = path.join(
      process.env.APPDATA || '',
      'io.github.baihejiangnan.dsh-launcher',
      'instances.json',
    )
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'))
    const home = String(process.env.DSH_HOME || '')
      .replace(/[\\/]+$/, '')
      .toLowerCase()
    const hit = (doc.instances || []).find(
      (i) => String(i.dshHome || '').replace(/[\\/]+$/, '').toLowerCase() === home,
    )
    return hit ? String(hit.name || '') : ''
  } catch {
    return ''
  }
}

/**
 * 把 DSH 窗口拉到前台。
 *
 * Windows 有「前台锁」：后台进程直接调 SetForegroundWindow 会被拒绝（实测返回 False）。
 * 破解办法是 DSH 自己的原生目录选择器也在用的那招 —— 先合成一次 Alt 按键，
 * 让系统认为「用户刚操作过」，随后 SetForegroundWindow 就会成功（实测 True）。
 *
 * 窗口靠标题认：启动器给每个实例开的窗口标题是 "DSH - <实例名>"。
 *
 * @param {string} instanceName 本实例名字；为空时退化为「第一个 DSH 窗口」。
 * @returns {Promise<{ok:boolean, detail:string}>} 结果。
 */
function focusDshWindow(instanceName) {
  return new Promise((resolve) => {
    const title = String(instanceName || '').replace(/'/g, "''")
    const fallback = title ? '$true' : '$false'
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      'Add-Type @"',
      'using System;using System.Text;using System.Runtime.InteropServices;',
      'public class DshFocusWin {',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);',
      '  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);',
      '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
      '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
      '}',
      '"@',
      '$want = \'' + title + '\'',
      '$allowFallback = ' + fallback,
      '$target = [IntPtr]::Zero',
      '[DshFocusWin]::EnumWindows({ param($h,$p)',
      '  if ([DshFocusWin]::IsWindowVisible($h)) {',
      '    $sb = New-Object System.Text.StringBuilder 512',
      '    [void][DshFocusWin]::GetWindowTextW($h,$sb,512)',
      '    $t = $sb.ToString()',
      "    if ($t -like 'DSH - *') {",
      '      if ($want -ne \'\' -and $t -eq ("DSH - " + $want)) { $script:target = $h }',
      '      elseif ($allowFallback -and $script:target -eq [IntPtr]::Zero) { $script:target = $h }',
      '    }',
      '  }',
      '  return $true',
      '}, [IntPtr]::Zero) | Out-Null',
      'if ($target -ne [IntPtr]::Zero) {',
      '  [void][DshFocusWin]::ShowWindow($target, 9)',
      '  [DshFocusWin]::keybd_event(0x12,0,0,[UIntPtr]::Zero)',
      '  [DshFocusWin]::keybd_event(0x12,0,0x0002,[UIntPtr]::Zero)',
      '  Start-Sleep -Milliseconds 60',
      '  $ok = [DshFocusWin]::SetForegroundWindow($target)',
      '  Start-Sleep -Milliseconds 150',
      '  $fg = ([DshFocusWin]::GetForegroundWindow() -eq $target)',
      '  Write-Output ("FOCUS " + $ok + " " + $fg)',
      '} else { Write-Output "NOTFOUND" }',
    ].join('\n')

    const encoded = Buffer.from(ps, 'utf16le').toString('base64')
    let out = ''
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        done({ ok: false, detail: '聚焦超时' })
      }, 12000)
      child.stdout.on('data', (c) => {
        out += c
      })
      child.on('error', () => {
        clearTimeout(timer)
        done({ ok: false, detail: 'powershell 不可用' })
      })
      child.on('close', () => {
        clearTimeout(timer)
        const line = out.trim().split(/\r?\n/).pop() || ''
        if (line.startsWith('FOCUS')) {
          done({ ok: line.includes('True True') || line.endsWith('True'), detail: line })
        } else if (line === 'NOTFOUND') {
          done({ ok: false, detail: '没找到 DSH 窗口（实例可能没在运行）' })
        } else {
          done({ ok: false, detail: line || '未知结果' })
        }
      })
    } catch (err) {
      done({ ok: false, detail: String((err && err.message) || err) })
    }
  })
}

/**
 * 把指定 pid 集合拥有的可见窗口切到前台（合成 Alt 解前台锁，理由见 focusDshWindow）。
 *
 * @param {number[]} pids 目标进程号。
 * @returns {Promise<{ok:boolean, detail:string}>} 结果。
 */
function focusWindowByPids(pids) {
  return new Promise((resolve) => {
    const list = (pids || []).filter((n) => Number.isInteger(n) && n > 0).join(',')
    if (!list) {
      resolve({ ok: false, detail: 'pid 列表为空' })
      return
    }
    const ps = [
      "$ErrorActionPreference='SilentlyContinue'",
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;',
      'public class DshFocusAny {',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);',
      '  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
      '}',
      '"@',
      '$want = @(' + list + ')',
      '$target = [IntPtr]::Zero',
      '[DshFocusAny]::EnumWindows({ param($h,$p)',
      '  if ([DshFocusAny]::IsWindowVisible($h)) {',
      '    $procId = 0',
      '    [void][DshFocusAny]::GetWindowThreadProcessId($h, [ref]$procId)',
      '    if ($want -contains $procId) { $script:target = $h }',
      '  }',
      '  return $true',
      '}, [IntPtr]::Zero) | Out-Null',
      'if ($target -ne [IntPtr]::Zero) {',
      '  [void][DshFocusAny]::ShowWindow($target, 9)',
      '  [DshFocusAny]::keybd_event(0x12,0,0,[UIntPtr]::Zero)',
      '  [DshFocusAny]::keybd_event(0x12,0,0x0002,[UIntPtr]::Zero)',
      '  Start-Sleep -Milliseconds 60',
      '  $ok = [DshFocusAny]::SetForegroundWindow($target)',
      '  Write-Output ("FOCUS " + $ok)',
      '} else { Write-Output "NOTFOUND" }',
    ].join('\n')

    runPowershell(ps, 12000)
      .then((out) => {
        const line = String(out || '').trim().split(/\r?\n/).pop() || ''
        if (line.startsWith('FOCUS')) resolve({ ok: line.includes('True'), detail: line })
        else if (line === 'NOTFOUND') resolve({ ok: false, detail: '这个进程没有可见窗口' })
        else resolve({ ok: false, detail: line || '未知结果' })
      })
      .catch((err) => resolve({ ok: false, detail: String((err && err.message) || err) }))
  })
}

/**
 * 把「已经开着的 DeepSeek 窗口」切到前台。
 *
 * 判据用**进程归属**而不是窗口标题：先查出属于本插件专用 profile 的 pid 集合，
 * 再枚举可见顶层窗口，pid 落在集合里的那个就是我们的窗口 ——
 * 网页把标题改成什么都认不错。
 *
 * @returns {Promise<{ok:boolean, detail:string}>} 结果。
 */
async function focusDeepSeekWindow() {
  const pids = (await scanProfilePids()) || []
  if (!pids.length) return { ok: false, detail: '没查到属于本插件的窗口进程' }
  return focusWindowByPids(pids)
}

/** 拿 CDP 的页面目标列表。 */
async function cdpListTargets(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/json/list')
    return await r.json()
  } catch {
    return null
  }
}

/** 等页面目标出现（窗口刚起时调试端口要过几秒才有页面）。 */
async function cdpWaitForPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const list = await cdpListTargets(port)
    if (Array.isArray(list)) {
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      // 🐞 2026-09-30 修复「有时传不过去」：不再拿第一个 page 就连 —— 用户在同一
      //    窗口里开多张标签页（新标签页 / 别的网站）时，第一个未必是 DSC 页面，
      //    脚本不在那、输入框也不在那，注入自然失败，且表现得「时好时坏」。
      //    优先挑 chat.deepseek.com 的页面，其次任何 deepseek.com 域，
      //    实在没有才退回第一个 page（保持旧行为，兼容非常规 URL）。
      const page =
        pages.find((t) => /chat\.deepseek\.com/i.test(String(t.url || ''))) ||
        pages.find((t) => /deepseek\.com/i.test(String(t.url || ''))) ||
        pages[0]
      if (page) return page
    }
    await sleep(500)
  }
  return null
}

/**
 * 连上调试端口，注册 binding 并注入按钮脚本。
 *
 * 幂等：已经连好就直接返回。窗口被关掉后重开会重新走一遍。
 *
 * @param {typeof DEFAULTS} cfg 配置。
 * @param {any} logger 日志。
 * @returns {Promise<{ok:boolean, detail:string}>} 结果。
 */
async function ensureCdpAttached(cfg, logger) {
  if (!cfg.relay) return { ok: false, detail: 'relay 已关闭' }
  if (relayCdp.ws && relayCdp.connected) return { ok: true, detail: 'CDP 已连接' }
  if (!relayCdp.port) {
    return {
      ok: false,
      detail: '当前窗口没有调试端口（可能是升级前打开的）。关掉 DeepSeek 窗口再重新打开即可。',
    }
  }
  if (typeof WebSocket !== 'function') {
    return { ok: false, detail: '当前 Node 没有全局 WebSocket（需要 Node 22+）' }
  }

  const page = await cdpWaitForPage(relayCdp.port, 15000)
  if (!page) return { ok: false, detail: '调试端口上没有页面目标' }

  let ws
  try {
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      // 🐞 2026-10-01：8s → 4s。回环上活端口连接 <300ms；4s 只在通道真坏时
      //    才等满 —— 自愈链路总预算必须压在客户端 20s 超时以内。
      const t = setTimeout(() => rej(new Error('连接超时')), 4000)
      ws.addEventListener('open', () => {
        clearTimeout(t)
        res()
      })
      ws.addEventListener('error', () => {
        clearTimeout(t)
        rej(new Error('握手失败'))
      })
    })
  } catch (err) {
    return { ok: false, detail: 'CDP 连接失败: ' + String((err && err.message) || err) }
  }

  let msgId = 0
  const pending = new Map()
  /** 单条 CDP 命令的等待上限。 */
  const CDP_CALL_TIMEOUT_MS = 10000
  const send = (method, params, timeoutMs) =>
    new Promise((res) => {
      const myId = ++msgId
      const t = setTimeout(() => {
        pending.delete(myId)
        res({ __timeout: true })
      }, Number(timeoutMs) > 0 ? Number(timeoutMs) : CDP_CALL_TIMEOUT_MS)
      pending.set(myId, (v) => {
        clearTimeout(t)
        res(v)
      })
      try {
        ws.send(JSON.stringify({ id: myId, method, params: params || {} }))
      } catch (err) {
        // socket 已经废了：立刻失败，别干等超时
        clearTimeout(t)
        pending.delete(myId)
        res({ __timeout: true })
      }
    })

  ws.addEventListener('message', (ev) => {
    let m
    try {
      m = JSON.parse(ev.data)
    } catch {
      return
    }
    if (m.id && pending.has(m.id)) {
      const fn = pending.get(m.id)
      pending.delete(m.id)
      fn(m.result ?? m.error)
      return
    }
    if (m.method === 'Runtime.bindingCalled') onBindingCalled(m.params, logger)
  })
  ws.addEventListener('close', () => {
    relayCdp.connected = false
    relayCdp.ws = null
    relayCdp.send = null
    logger?.info?.(`[${name}] CDP 连接已断开（网页端窗口关掉了？）`)
  })
  ws.addEventListener('error', () => {
    relayCdp.lastError = 'websocket error'
  })

  // 🐞 2026-10-01：握手命令全部压到 1.5s —— 它们本是毫秒级操作，10s 默认上限
  //    只会在「通道真坏了」时白拖时间。/inject 的自愈链路（首试 4s + 重连握手 +
  //    重试 4s）一旦总耗时超过客户端 20s 超时，请求就会挂到用户侧「点了 20 秒
  //    没反应」（09:50 超时现场：宿主卡在重连里，请求始终没有应答，
  //    a2b 日志里连一条记录都落不下）。
  await send('Runtime.enable', {}, 1500)
  await send('Page.enable', {}, 1500)
  await send('Runtime.addBinding', { name: '__dshRelay' }, 1500)

  let source
  try {
    source = buildInjectedSource(cfg)
  } catch (err) {
    return { ok: false, detail: '读不到 page-script.js: ' + String((err && err.message) || err) }
  }
  // 只保留最新一条「新文档自动注入」注册：重连/升级时先撤掉上一条，
  // 否则页面刷新后旧版脚本会跟着一起跑（旧版会给每条回复插按钮，
  // 和新版的划词气泡打架）。
  if (relayCdp.scriptId) {
    try {
      await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: relayCdp.scriptId }, 1500)
    } catch (err) {
      /* 撤不掉不影响本次注入 */
    }
  }
  const added = await send('Page.addScriptToEvaluateOnNewDocument', { source }, 1500)
  relayCdp.scriptId = (added && added.identifier) || ''
  // 对「已经打开着」的页面也立即生效（不用刷新）
  await send('Runtime.evaluate', { expression: source }, 1500)

  relayCdp.ws = ws
  relayCdp.connected = true
  relayCdp.bound = true
  relayCdp.lastError = ''
  // 把这条 CDP 通道的 send 挂到状态对象上，别的地方（比如 A→B 注入）要用它
  relayCdp.send = send
  logger?.info?.(`[${name}] CDP 已连接并注入接力脚本（端口 ${relayCdp.port}）`)
  return { ok: true, detail: 'CDP 已连接并注入脚本' }
}

/**
 * 强制断开当前这条 CDP 通道，让下一次 `ensureCdpAttached()` 重新建立连接。
 *
 * 为什么需要它：僵尸 socket 的 `readyState` 仍是 OPEN，`ensureCdpAttached()` 的
 * 幂等短路（`if (relayCdp.ws && relayCdp.connected) return 已连接`）就会一直放行，
 * 永远修不好。先 close() 再清状态，短路条件才会失效。
 *
 * @param {string} why 原因（只用于日志）。
 * @returns {void}
 */
function forceCdpDisconnect(why) {
  const old = relayCdp.ws
  relayCdp.ws = null
  relayCdp.send = null
  relayCdp.connected = false
  relayCdp.lastError = why || 'forced disconnect'
  try {
    if (old && typeof old.close === 'function') old.close()
  } catch {
    /* 关不掉也无所谓，状态已经清干净了 */
  }
}

/**
 * 在网页端执行一段 JS 并把结果拿回来（A→B 注入、接力回执都靠它）。
 *
 * 🐞 2026-09-27 修复的现场故障（真机实测复现）：
 *   CDP 那条 WebSocket 会「连着但不再应答」——`ws.readyState` 仍是 OPEN、
 *   `relayCdp.connected` 仍是 true，于是 `ensureCdpAttached()` 每次都直接返回
 *   「已连接」，命令却一条条等到 10 秒超时。后果是**每次互传都误报失败**：
 *   DSH 其实已经写进输入框了，网页端却收到 `{ok:false,detail:'CDP 调用超时'}`，
 *   于是弹「注入失败，已复制到剪贴板」并污染剪贴板 —— 而且**永不恢复**。
 *
 * 修法：一次超时就判定这条 socket 已僵死 → 强制断开 → 重建一次 → 重试一次。
 * 单次调用最坏耗时 = 超时 + 重连（≤8s）+ 重试，所以调用方可以给更短的超时。
 *
 * @param {string} expression 要执行的表达式，返回值请是 JSON 可序列化的对象。
 * @param {number} [timeoutMs] 首次尝试的等待上限；不传用默认 10 秒。
 * @returns {Promise<{ok:boolean, value?:any, detail?:string}>} 结果。
 */
async function cdpEvaluate(expression, timeoutMs, cfg, logger) {
  if (!relayCdp.send) return { ok: false, detail: 'CDP 未连接' }

  const attempt = async () => {
    const fn = relayCdp.send
    if (!fn) return { ok: false, detail: 'CDP 未连接' }
    const r = await fn(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: false },
      timeoutMs,
    )
    if (!r) return { ok: false, detail: 'CDP 无响应' }
    if (r.__timeout) return { ok: false, detail: 'CDP 调用超时', __timeout: true }
    if (r.exceptionDetails) {
      // ⚠️ exceptionDetails.text 通常只有 "Uncaught" 一个词，完整信息在
      //    exception.description 里（如 "TypeError: xxx is not a function"）。
      //    只取 text 会让诊断日志变成哑谜（13:50 实测：网页端脚本抛错: Uncaught，
      //    真实错误被吞掉）。两级取值 + 截断，把真相带回来。
      const ed = r.exceptionDetails
      const desc =
        (ed.exception && (ed.exception.description || ed.exception.className)) ||
        ed.text ||
        '(未知异常)'
      return { ok: false, detail: '网页端脚本抛错: ' + String(desc).slice(0, 300) }
    }
    return { ok: true, value: r.result ? r.result.value : undefined }
  }

  const first = await attempt()
  if (!first.__timeout) return first

  // 超时 → 认为这条通道僵死，强制重建后只重试一次（绝不无限重试）。
  // ⚠️ cfg 必须由调用方传进来：本函数在模块作用域，而 config 是 apply() 的闭包
  //    变量 —— 直接引用会抛 `config is not defined`（这个坑我踩过一次，别再来）。
  try {
    forceCdpDisconnect('命令超时，准备重连')
    const re = await ensureCdpAttached(cfg || DEFAULTS, logger)
    if (!re.ok) return { ok: false, detail: 'CDP 调用超时，且重连失败: ' + re.detail }
  } catch (err) {
    return { ok: false, detail: 'CDP 调用超时，重连抛错: ' + String((err && err.message) || err) }
  }
  const second = await attempt()
  if (second.__timeout) {
    return { ok: false, detail: 'CDP 调用超时（重连后仍无响应，网页端窗口可能需要重开）' }
  }
  return second
}

/**
 * 把文本写进系统剪贴板 —— A→B 注入失败时的兜底。
 *
 * 走 base64 传参，避免中文/引号/换行在命令行里被转义搞坏。
 *
 * @param {string} text 要复制的文本。
 * @returns {Promise<boolean>} 是否成功。
 */
async function copyToClipboard(text) {
  try {
    const b64 = Buffer.from(String(text), 'utf8').toString('base64')
    const script =
      "$ErrorActionPreference='Stop'; " +
      "$t=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" +
      b64 +
      "')); Set-Clipboard -Value $t; Write-Output 'COPIED'"
    const out = await runPowershell(script, 12000)
    return Boolean(out && out.includes('COPIED'))
  } catch {
    return false
  }
}

/** 处理页面回传（binding 调用）。 */
function onBindingCalled(params, logger) {
  if (!params || params.name !== '__dshRelay') return
  let msg
  try {
    msg = JSON.parse(params.payload)
  } catch {
    return
  }

  if (msg.kind === 'relay') {
    relaySeq++
    // id 会一路带到客户端：客户端写完输入框后用它回执给网页端
    // （失败时网页端要兜底复制到剪贴板，所以必须能对上号）
    relayQueue.push({ seq: relaySeq, kind: 'relay', id: msg.id, text: msg.text, meta: msg.meta || {} })
    while (relayQueue.length > 20) relayQueue.shift()
    logger?.info?.(
      `[${name}] 收到划词接力 ${String(msg.text || '').length} 字符（选中 ${String(
        (msg.meta && msg.meta.selected) || '',
      )} 字）`,
    )
    // 立刻把 DSH 拉到前台：既满足「自动唤起」，也顺带解掉后台窗口的计时器节流
    focusDshWindow(dshInstanceName()).then((r) =>
      logger?.info?.(`[${name}] 聚焦 DSH 窗口: ${r.ok ? '成功' : r.detail}`),
    )
  } else if (msg.kind === 'branch') {
    // 网页端「↪ 分支到 DSH」：整段对话上下文 → DSH 自动新建会话并填入（v1.1.0）。
    // 与划词接力共用 relayQueue 与轮询通道，但带独立 branchSeq 与 isBranch 标记，
    // 客户端据此走 applyBranch（新建会话自动化），互不干扰。
    relaySeq++
    branchSeq++
    relayQueue.push({
      seq: relaySeq, // 共享游标：/relay?since= 的过滤语义保持不变
      kind: 'branch',
      isBranch: true,
      branchSeq, // 分支自己的序号
      id: msg.id,
      text: typeof msg.text === 'string' ? msg.text : String(msg.text || ''),
      meta: msg.meta || {},
    })
    while (relayQueue.length > 20) relayQueue.shift()
    logger?.info?.(
      `[${name}] 收到分支请求 ${String(msg.text || '').length} 字符` +
        `（${msg.meta && msg.meta.includeHistory ? '全量历史' : '仅末条回复'}，branchSeq ${branchSeq}）`,
    )
    // 接下来的自动化发生在 DSH 里：和划词接力一样，先把 DSH 拉到前台
    focusDshWindow(dshInstanceName()).then((r) =>
      logger?.info?.(`[${name}] 聚焦 DSH 窗口: ${r.ok ? '成功' : r.detail}`),
    )
  } else if (msg.kind === 'copy') {
    // 网页端注入失败时的兜底：请宿主机把内容写进**系统剪贴板**
    // （比浏览器侧的 execCommand / clipboard API 可靠，不受权限限制）
    copyToClipboard(String(msg.text || '')).then((ok) => {
      logger?.warn?.(
        `[${name}] 网页端注入失败（${msg.detail || '未说明'}），系统剪贴板写入${ok ? '成功' : '失败'}`,
      )
      relaySeq++
      relayQueue.push({
        seq: relaySeq,
        kind: 'error',
        detail: '网页端注入失败，内容已' + (ok ? '复制到剪贴板' : '尝试复制') + ' —— 请在 DSH 输入框里手动粘贴',
      })
      while (relayQueue.length > 20) relayQueue.shift()
    })
  } else if (msg.kind === 'error') {
    relaySeq++
    relayQueue.push({ seq: relaySeq, kind: 'error', detail: msg.detail })
    while (relayQueue.length > 20) relayQueue.shift()
    focusDshWindow(dshInstanceName())
  } else if (msg.kind === 'diagnostic') {
    relayDiag = msg
    logger?.warn?.(
      `[${name}] 网页端抓不到回复容器，已记录结构诊断（共 ${(msg.candidates || []).length} 个候选）`,
    )
  } else if (msg.kind === 'ready') {
    // 带上 mode/版本：升级后一眼就能从 DSH 日志确认网页端跑的是哪一版脚本
    logger?.info?.(
      `[${name}] 接力脚本已在网页端就绪（${msg.mode || 'legacy'}${
        msg.scriptVersion ? ' ' + msg.scriptVersion : ''
      }）: ${msg.url}`,
    )
  }
}

// ───────────────────────────────── 插件主体 ─────────────────────────────────

export const name = 'dsh-deepseek-web-relay'
export const inject = ['webServer']

/**
 * 插件主体。
 *
 * 整个函数体被 try/catch 包住：宿主半边**绝不允许**因为自身异常而影响 DSH 启动。
 * 最坏情况是这个插件静默失效（侧边栏没有 DeepSeek Relay 菜单项），DSH 本体照常运行。
 *
 * @param {any} ctx Cordis 上下文。
 * @param {unknown} rawConfig 用户配置（来自 cordis 行）。
 */
export function apply(ctx, rawConfig) {
  const disposers = []

  try {
    const { config, warnings } = normalizeConfig(rawConfig)
    for (const w of warnings) ctx.logger?.warn?.(`[${name}] ${w}`)

    /**
     * 注册路由，自动套信任栅栏。
     * @param {string} routePath 精确路径。
     * @param {(req:any,res:any)=>any} handler 处理函数。
     * @param {{raw?:boolean}} [opts] raw=true 时跳过信任栅栏（仅诊断上报用）。
     */
    function route(routePath, handler, opts) {
      disposers.push(
        ctx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            if (!opts?.raw) {
              const code = rejection(req)
              if (code !== null) {
                res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('forbidden')
                return
              }
            }
            try {
              await handler(req, res)
            } catch (err) {
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
              }
              res.end(`${name}: ` + String((err && err.message) || err))
            }
          },
        }),
      )
    }

    /** 统一的 JSON 响应。 */
    function sendJson(res, code, obj) {
      const body = JSON.stringify(obj)
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(body)),
      })
      res.end(body)
    }

    // ── 1. 配置快照 ──────────────────────────────────────────────────────
    route(CONFIG_PATH, (_req, res) => {
      const f = findBrowser(config)
      sendJson(res, 200, {
        ...config,
        browser: f ? f.kind : null,
        browserExe: f ? f.exe : null,
        profileDir: profileDir(),
      })
    })

    // ── 2. 窗口状态 ──────────────────────────────────────────────────────
    route(STATE_PATH, async (_req, res) => {
      const st = await isWindowOpen(config)
      sendJson(res, 200, { open: st.open, pids: st.pids.length, via: st.via })
    })

    // ── 3. 打开窗口 ──────────────────────────────────────────────────────
    route(OPEN_PATH, async (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        res.writeHead(405).end('method not allowed')
        return
      }
      const payload = (await readJson(req)) || {}

      // 已经开着就不重复开 —— 否则连点几下会开出一堆窗口
      let st = await isWindowOpen(config)
      if (!st.open && Date.now() - lastLaunchAt < 15000) {
        // 刚开过但还没查到进程（冷启动竞态），再等一会儿复查一次
        await sleep(2500)
        st = await isWindowOpen(config)
      }
      if (st.open) {
        // 窗口已经存在：按需求「切回/聚焦已有窗口」，而不是再开一个
        const focused = await focusDeepSeekWindow()
        // 接力通道可能还没连上（比如窗口是升级前开的），补一次连接
        const attached = await ensureCdpAttached(config, ctx.logger)
        ctx.logger?.info?.(
          `[${name}] 窗口已存在（判据 ${st.via}）→ 聚焦: ${focused.ok ? '成功' : focused.detail}`,
        )
        sendJson(res, 200, {
          ok: true,
          mode: 'focused',
          focused: focused.ok,
          detail:
            (focused.ok
              ? 'DeepSeek 窗口已存在，已切回前台。'
              : 'DeepSeek 窗口已存在（没能切到前台：' + focused.detail + '）。') +
            '接力通道：' +
            attached.detail,
        })
        return
      }

      // 接力开启时，先挑一个空闲端口给 CDP 用
      const debugPort = config.relay ? await pickFreePort() : 0
      const geometry = computeGeometry(payload.rect, config)
      const result = launchWindow(config, geometry, debugPort)
      if (result.ok) {
        lastLaunchAt = Date.now()
        relayCdp.port = result.debugPort || 0
        if (relayCdp.port) {
          // 窗口要过几秒才有页面，这里异步补连接，不阻塞这次响应
          ensureCdpAttached(config, ctx.logger).then((r) =>
            ctx.logger?.info?.(`[${name}] 接力通道: ${r.ok ? '就绪' : r.detail}`),
          )
        }
      }
      ctx.logger?.info?.(`[${name}] open -> ${result.mode}: ${result.detail}`)
      sendJson(res, result.ok ? 200 : 500, result)
    })

    // ── 4. 关闭窗口 ──────────────────────────────────────────────────────
    route(CLOSE_PATH, async (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        res.writeHead(405).end('method not allowed')
        return
      }
      const result = await closeWindow()
      relayCdp.port = 0
      relayCdp.connected = false
      try {
        relayCdp.ws?.close()
      } catch {
        /* 忽略 */
      }
      relayCdp.ws = null
      relayCdp.send = null
      sendJson(res, 200, result)
    })

    // ── 4b. 上下文接力：客户端轮询这里取新内容 ──────────────────────────
    // 客户端每 1.5 秒问一次「比 since 新的有没有」。用短轮询而不是 SSE，
    // 是为了简单可靠、出问题好查 —— 反正都是本机回环，开销可忽略。
    route(RELAY_PATH, async (req, res) => {
      const u = new URL(String(req.url || ''), 'http://127.0.0.1')
      const since = Number.parseInt(u.searchParams.get('since') || '0', 10) || 0
      const items = relayQueue.filter((it) => it.seq > since)
      sendJson(res, 200, {
        ok: true,
        seq: relayQueue.length ? relayQueue[relayQueue.length - 1].seq : since,
        items,
        // 抓不到回复时的结构诊断，客户端可以提示用户
        diag: relayDiag
          ? { url: relayDiag.url, candidates: (relayDiag.candidates || []).slice(0, 6) }
          : null,
        relay: {
          enabled: config.relay,
          port: relayCdp.port,
          connected: relayCdp.connected,
          lastError: relayCdp.lastError,
        },
      })
    })

    // ── 4b-2. 接力回执：DSH 客户端写完输入框后回报成功/失败 ──────────────
    // 网页端气泡点击后就在等这个回执：
    //   ok=false 或超时没回执 → 网页端兜底写剪贴板 + 弹窗提示。
    //
    // ⚠️ 首次尝试只给 3 秒：回执是「尽力而为」的通知，不该让宿主在这里干等 10 秒。
    //    3 秒没回来基本就是通道僵死，交给 cdpEvaluate 去重连（重连+重试仍在
    //    网页端 15 秒预算之内）。
    route(RELAY_ACK_PATH, async (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        res.writeHead(405).end('method not allowed')
        return
      }
      const payload = (await readJson(req)) || {}
      const ack = {
        id: String(payload.id || ''),
        ok: payload.ok === true,
        detail: String(payload.detail || ''),
      }
      if (!ack.id) {
        sendJson(res, 400, { ok: false, detail: '缺少 id' })
        return
      }
      // 🐞 2026-09-27 修复的竞态（真机实测复现）：
      //   网页端 `deliver()` 的顺序是「先 send({kind:'relay'})，再设 pending 定时器」。
      //   而宿主这条路很快（实测 DSH 侧写入只要 ~110ms），回执**赶在 pending 被设上
      //   之前**就送到了页面 → 页面的 `__dshRelayAck` 里 `if (!pending) return` 直接丢弃
      //   → 气泡永远停在「发送中…」，直到 15 秒超时才兜底写剪贴板。
      //   用户感受到的就是「DSC→DSH 很卡」。
      //   修法：宿主这边**推迟一拍再回执**（先让页面把 pending 登记好）。
      //   延迟只在「本机回环 + CDP」这条路上生效，代价可忽略。
      await new Promise((r2) => setTimeout(r2, 250))
      const r = await cdpEvaluate(
        'window.__dshRelayAck ? window.__dshRelayAck(' +
          JSON.stringify(ack) +
          ') : ({ ok:false, detail:"网页端脚本没有 __dshRelayAck（窗口是升级前打开的，关掉重开即可）" })',
        3000,
        config,
        ctx.logger,
      )
      if (!ack.ok) ctx.logger?.warn?.(`[${name}] 回执网页端：失败（${ack.detail || '未说明'}）`)
      // 用 warn 而不是 info：通道出问题时这条日志是排查的唯一线索
      if (!r.ok) ctx.logger?.warn?.(`[${name}] 回执没能送到网页端：${r.detail}`)
      sendJson(res, 200, { ok: r.ok, detail: r.detail })
    })

    // ── 4c. 把 DSH 窗口拉到前台（客户端在自己被唤起后也可再点一下用）──────
    route(FOCUS_PATH, async (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        res.writeHead(405).end('method not allowed')
        return
      }
      const r = await focusDshWindow(dshInstanceName())
      sendJson(res, 200, r)
    })

    // ── 4d. 手动重连接力通道（窗口是升级前开的、或连接断了时用）─────────
    route(REATTACH_PATH, async (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        res.writeHead(405).end('method not allowed')
        return
      }
      if (!relayCdp.port && config.relay) {
        // 没记住端口：从正在运行的 Chrome 命令行里把端口抠出来
        const pids = await scanProfilePids()
        if (pids && pids.length) {
          const found = await findDebugPortInCmdline()
          if (found) relayCdp.port = found
        }
      }
      const r = await ensureCdpAttached(config, ctx.logger)
      sendJson(res, 200, { ...r, port: relayCdp.port })
    })

    // ── 4e. A→B：把 DSH 里选中的文字注入网页端的输入框 ──────────────────
    //
    // 链路（复用接力那套 CDP 通道，只是方向反过来）：
    //   DSH 划词气泡 → 本路由 → CDP Runtime.evaluate 调页面里的
    //   window.__dshInjectText(text) → 写进网页端底部输入框 → 唤起网页端窗口
    //
    // ⚠️ 这里同样没有 Tauri IPC 可用（DSH 插件体系里没有 Tauri 层，而且那个窗口
    //    是独立 Chrome 进程，不是 Tauri webview）。CDP 是唯一真实可用的通道。
    route(INJECT_PATH, async (req, res) => {
      if ((req.method || '').toUpperCase() !== 'POST') {
        res.writeHead(405).end('method not allowed')
        return
      }
      const payload = (await readJson(req)) || {}
      const text = String(payload.text || '')
      if (!text.trim()) {
        a2bLogAppend({ chars: 0, ok: false, reason: 'empty' })
        sendJson(res, 400, { ok: false, reason: 'empty', detail: '没有内容可发送' })
        return
      }
      // A→B 全链路诊断第 1 步：宿主已收到请求（后续各步都跟随这条日志）
      ctx.logger?.info?.(`[${name}] A→B 注入请求：${text.length} 字符`)
      // 📋 持久日志的现场记录（首试 / 自愈 / 终态各步骤都往这里塞）
      const a2b = { chars: text.length }

      // 1) 窗口得开着 —— 没开就**自动打开再注入**（v1.3.0 行为变更）。
      //    旧行为是 409 让用户手动去侧边栏开窗（早期需求），但用户实测痛点正是
      //    「第一次点气泡只报错没开窗；手动开完窗，原来的气泡早没了，还得重新
      //    划词重点」——观感就是「要重复点好几遍」。现在：点一下气泡 =
      //    自动开窗 + 注入，全链路一次完成；自动开窗失败才回退报错。
      let st = await isWindowOpen(config)
      if (!st.open) {
        ctx.logger?.info?.(`[${name}] A→B 注入时窗口未开，自动打开…`)
        a2b.autoOpen = true
        try {
          const debugPort = config.relay ? await pickFreePort() : 0
          // 没有前端传来的宿主窗口矩形 → computeGeometry 返回 null → 系统默认位置
          const geometry = computeGeometry(undefined, config)
          const result = launchWindow(config, geometry, debugPort)
          if (!result.ok) {
            a2bLogAppend({
              ...a2b,
              ok: false,
              reason: 'no-window',
              windowDetail: String(result.detail || 'launchWindow 失败'),
            })
            sendJson(res, 409, {
              ok: false,
              reason: 'no-window',
              detail: 'DeepSeek Relay 窗口打不开：' + (result.detail || '未知原因'),
            })
            return
          }
          lastLaunchAt = Date.now()
          relayCdp.port = result.debugPort || 0
        } catch (e) {
          const why = String((e && e.message) || e)
          a2bLogAppend({ ...a2b, ok: false, reason: 'no-window', windowDetail: why })
          sendJson(res, 409, { ok: false, reason: 'no-window', detail: 'DeepSeek Relay 窗口打不开：' + why })
          return
        }
        // 冷启动：等进程起来再复查（页面就绪由后面 ensureCdpAttached 的等待兜住）
        await sleep(2500)
        st = await isWindowOpen(config)
        if (!st.open) {
          a2bLogAppend({ ...a2b, ok: false, reason: 'no-window', windowDetail: '自动开窗后仍未检测到进程' })
          sendJson(res, 409, {
            ok: false,
            reason: 'no-window',
            detail: '窗口正在启动但还没就绪，请稍候 2-3 秒再点一次气泡即可。',
          })
          return
        }
      }

      // 2) 窗口开着，但我可能**不知道调试端口**（宿主重启过、窗口是上一个实例开的，
      //    或者同 home 起了两个实例互相抢窗口）。这种情况以前直接失败兜底，
      //    现在先自救一次：从 Chrome 命令行里把端口抠出来（与 /reattach 用的是同一个函数）。
      if (!relayCdp.port && config.relay) {
        const pids = await scanProfilePids()
        if (pids && pids.length) {
          const found = await findDebugPortInCmdline()
          if (found) {
            relayCdp.port = found
            a2b.portRescued = found
            ctx.logger?.info?.(`[${name}] 注入前自救：从命令行找回调试端口 ${found}`)
          }
        }
      }
      a2b.cdpPort = relayCdp.port || 0

      // 3) 确保 CDP 连着、脚本注入了
      //    ⚠️ CDP 未连接 / 连接失败时把详情原样带回客户端（detail 字段），
      //       绝不让请求悬空 —— 客户端拿不到 detail 就只能显示「未知原因」。
      let detail = ''
      let how = ''
      let injected = false
      const attached = await ensureCdpAttached(config, ctx.logger)
      a2b.attached = attached.ok === true
      if (!attached.ok) {
        detail = attached.detail
        a2b.attachDetail = String(detail || '')
        ctx.logger?.warn?.(`[${name}] A→B CDP 通道不可用：${detail}`)
      } else {
        // 4) 调页面里的注入函数。首试只等 4 秒（2026-10-01 从 5s 收紧）：
        //    给下面的自愈重试留足预算 —— 客户端整条请求的超时是 20 秒，
        //    自愈链路（重连握手 1.5s/命令 + 重试 4s）必须稳稳落在预算内，
        //    否则就是「点了 20 秒没反应」。
        const expr =
          'window.__dshInjectText ? window.__dshInjectText(' +
          JSON.stringify(text) +
          ') : ({ ok:false, detail:"网页端脚本没注入（窗口可能是升级前打开的，关掉重开即可）" })'
        let r = await cdpEvaluate(expr, 4000, config, ctx.logger)
        // 📋 首试现场（无论成败都记 —— 复盘间歇性失败的关键证据）
        a2b.first = {
          ok: r.ok === true,
          valueOk: Boolean(r.value && r.value.ok),
          detail: String((r.value && r.value.detail) || r.detail || '').slice(0, 200),
        }
        // 🩹 自愈重试（「有时传不过去」的修法）：明确没写进去（脚本不在页面上 /
        //    没找到输入框 / CDP 层面失败）时，多半是暂态 —— 页面刚刷新的窗口期、
        //    宿主重启后连接挑错了页面、脚本没跟上。强制重连一次 CDP：
        //    重连过程会重新挑页面（优先 chat.deepseek.com）并把脚本补注到
        //    已开着的页面上，然后再试一次。
        //    ⚠️ 只在「明确没写进去」时救 —— 超时场景内容可能其实已经进去了，
        //    盲目重试会追加成两份。
        const firstDetail = String((r.value && r.value.detail) || r.detail || '')
        const clearlyNotWritten =
          (r.value && r.value.ok === false && /没注入|没找到/.test(firstDetail)) ||
          (!r.ok && !/超时/.test(firstDetail))
        if (clearlyNotWritten) {
          a2b.rescued = true
          ctx.logger?.info?.(
            `[${name}] A→B 自愈：首次未写入（${firstDetail || '未知'}），强制重连 CDP（重挑页面 + 补脚本）后重试一次`,
          )
          forceCdpDisconnect('A→B 注入自愈重试')
          const re = await ensureCdpAttached(config, ctx.logger)
          a2b.reconnectOk = re.ok === true
          if (re.ok) {
            r = await cdpEvaluate(expr, 4000, config, ctx.logger)
            a2b.retry = {
              ok: r.ok === true,
              valueOk: Boolean(r.value && r.value.ok),
              detail: String((r.value && r.value.detail) || r.detail || '').slice(0, 200),
            }
          } else {
            r = { ok: false, detail: '自愈重连失败: ' + re.detail }
            a2b.retry = { ok: false, detail: String(re.detail || '').slice(0, 200) }
          }
        }
        if (!r.ok) {
          detail = r.detail
          ctx.logger?.warn?.(`[${name}] A→B 调用 __dshInjectText 失败：${detail}`)
        } else if (r.value && r.value.ok) {
          injected = true
          how = r.value.how || 'unknown'
          detail = r.value.detail || '已填入输入框'
        } else {
          detail = (r.value && r.value.detail) || '网页端拒绝注入'
          ctx.logger?.warn?.(`[${name}] A→B 网页端注入未成功：${detail}`)
        }
      }

      // 4) 不管成没成，都把网页端窗口拉到前台 —— 用户要能看见结果。
      //    v1.4.0：先对**实际注入的那一页**做 Page.bringToFront（精确到窗口），
      //    再退而求其次按 PID 聚焦进程 —— 以前只按 PID 聚焦，profile 里若堆了
      //    多个 chat 窗口，被推到前台的未必是收到内容的那个，用户盯着空输入框
      //    以为「点了好几下都没反应」。
      try {
        if (injected && relayCdp.send) await relayCdp.send('Page.bringToFront', {}, 1500)
      } catch (err) {
        /* 拉前台失败不阻断主流程，下面还有 PID 聚焦兜底 */
      }
      const focused = await focusDeepSeekWindow()

      if (injected) {
        ctx.logger?.info?.(`[${name}] A→B 注入成功（${how}）`)
        a2bLogAppend({ ...a2b, ok: true, how })
        sendJson(res, 200, {
          ok: true,
          how,
          detail,
          focused: focused.ok,
          focusDetail: focused.detail,
        })
        return
      }

      // 5) 兜底：写进系统剪贴板，让用户手动粘贴
      const copied = await copyToClipboard(text)
      ctx.logger?.warn?.(`[${name}] A→B 注入失败（${detail}），已复制到剪贴板: ${copied}`)
      a2bLogAppend({ ...a2b, ok: false, copied, detail: String(detail || '').slice(0, 300) })
      sendJson(res, 200, {
        ok: false,
        reason: 'inject-failed',
        copied,
        detail,
        focused: focused.ok,
        focusDetail: focused.detail,
      })
    })

    // ── 5. 自诊断上报 ────────────────────────────────────────────────────
    // 单独放行（raw）：这条端点只接收、只写一个固定路径的 JSON 文件，
    // 不回传任何数据，也不接受客户端指定路径，风险面可控。
    route(
      STATUS_PATH,
      async (req, res) => {
        if ((req.method || '').toUpperCase() !== 'POST') {
          res.writeHead(405).end('method not allowed')
          return
        }
        const record = (await readJson(req)) || { parseFailed: true }
        const f = findBrowser(config)
        try {
          fs.writeFileSync(
            STATUS_FILE,
            JSON.stringify(
              {
                at: new Date().toISOString(),
                dshHome: process.env.DSH_HOME || null,
                node: process.version,
                platform: process.platform,
                browser: f ? { kind: f.kind, exe: f.exe } : null,
                profileDir: profileDir(),
                received: record,
              },
              null,
              2,
            ),
            'utf8',
          )
        } catch {
          /* 写盘失败不影响客户端 */
        }
        res.writeHead(204)
        res.end()
      },
      { raw: true },
    )

    // 每次插件加载时清掉上一次的状态，避免读到过期结果
    try {
      fs.rmSync(STATUS_FILE, { force: true })
    } catch {
      /* 忽略 */
    }
    ctx.logger?.info?.(`[${name}] loaded; status file: ${STATUS_FILE}`)
    ctx.logger?.info?.(`[${name}] profile: ${profileDir()}`)

    // 刻意**不做**任何 index 注入：package.json 声明了 dsh.client，DSH 的
    // client-modules 已经把 client.js 编进启动 combo bundle；宿主再注入一行
    // <script> 会让同一个模块注册两次，register() 抛 "duplicate factory
    // registration" 并中断整段 bundle，排在后面的插件全部加载不上（首页白屏）。
  } catch (err) {
    // 宿主半边的任何异常都在这里被吞掉并记日志 —— 不让插件把 DSH 拖下水。
    ctx.logger?.error?.(
      `[${name}] 宿主半边初始化失败（插件已停用，DSH 不受影响）: ${String(err && err.message)}`,
    )
  }

  ctx.effect?.(() => () => {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 注销失败不影响卸载 */
      }
    }
  })
}

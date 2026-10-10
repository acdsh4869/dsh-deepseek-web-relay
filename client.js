/**
 * dsh-deepseek-web-relay —— 客户端半边（Client Half）
 *
 * v1.7.0 起，UI 是**左侧边栏的原生菜单项**（「扩展管理 / 定时任务 / IM」那一列）：
 *
 *   ┌──────────────────────────────┐
 *   │  🧩 扩展管理                  │
 *   │  ⏰ 定时任务                  │
 *   │  💬 DeepSeek Relay          ← 注册在 sidebar.panellist
 *   └──────────────────────────────┘
 *            ↓ 点一下
 *   用 Chrome/Edge 以 --app= 打开独立窗口（登录态落盘），已开着就切回前台
 *
 * 本文件提供三处 UI：
 *   1. `sidebar.panellist`（kind:"list"）—— 左侧菜单项「DeepSeek Relay」，点它打开网页端窗口；
 *   2. `shell.overlay`（root 作用域）—— 划词气泡「🐋 传给Chat」（A→B）；
 *   3. `conversation.session.header.utilities` —— 接力桥（B→A）。
 *
 * ⚠️ 旧版挂在 `sidebar.brand.name`（single slot，靠 priority 抢位）上的
 * 「顶部品牌行下拉切换器」已**整个删除**：那个 slot 位于官方「新建会话」按钮的子树里，
 * 桌面壳会把这一支隐藏（实测元素在 DOM 里、尺寸 0×0、display:none，内联样式 +
 * !important 都压不过），属结构性不可用。详见 CHANGELOG 的 v1.7.0 一节。
 *
 * 零构建：DSH 的 client module loader 提供 require 种子表，
 * react / @deepseek-ai/dsh-client-ui-primitives 直接 require 即可。
 *
 * v1.1.0 起，轮询还会处理网页端「↪ 分支到 DSH」按钮发回的 kind:'branch'
 * 消息：自动点击「新建会话」、等新输入框挂载后把整段上下文写入（applyBranch）。
 *
 * 防污染：本文件里每一处外部依赖与注册都单独 try/catch。任何一处失败都只让
 * 「这一处」失效，不会抛到 combo bundle 上（那会导致排在后面的插件全部加载不了）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web-relay',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')

    /**
     * UI 原语（FishLogo / BrandWordmark）。可选加载：缺了也不能让插件挂掉，
     * 退回纯文本品牌名即可。
     */
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (err) {
      primitives = null
    }

    const BASE = '/dsh-deepseek-web-relay'
    const STORAGE_KEY = 'dsh-deepseek-web-relay.mode'

    /** 两种模式。'dsh' = 正常用 DSH；'deepseek' = 独立窗口开网页端。 */
    const MODE_DSH = 'dsh'
    const MODE_WEB = 'deepseek'

    /**
     * 修复标记：事件隔离补丁（v1.4.0）。
     * 每次切换模式都会随诊断一起上报，落在 %TEMP%\dsh-deepseek-web-relay-status.json。
     * 有了它就能一眼确认"浏览器里跑的是不是修复版"，不用开 DevTools
     * （桌面壳 WebView2 默认没有 F12）。
     */
    const GUARD_ID = 'event-isolation-v1.4.0'

    // ─────────────────────────── 自诊断上报 ───────────────────────────
    // 桌面壳（WebView2）默认不开 F12，浏览器 devtools 用不了；而 slot 注册发生在
    // 浏览器侧，服务端日志看不见。所以把「加载了没有 / 注册结果」回传给宿主落盘。
    // 上报失败**绝不允许**影响插件本身。
    const DIAG = []

    function diag(msg) {
      try {
        DIAG.push(String(msg))
        if (DIAG.length > 60) DIAG.shift()
      } catch (err) {
        /* 忽略 */
      }
    }

    function reportStatus(extra) {
      try {
        const payload = {
          client: 'dsh-deepseek-web-relay',
          loaded: true,
          href: String(window.location.href || '').replace(/token=[^&]*/, 'token=***'),
          diag: DIAG.slice(),
        }
        if (extra) for (const k in extra) payload[k] = extra[k]
        // 同步 POST：必须在页面卸载/异常前送达
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${BASE}/status`, false)
        xhr.setRequestHeader('Content-Type', 'application/json')
        xhr.send(JSON.stringify(payload))
      } catch (err) {
        /* 上报失败绝不影响插件 */
      }
    }

    /** 同步 GET 一个小 JSON；失败返回 null（不抛）。 */
    function getJson(path) {
      try {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', path, false)
        xhr.send(null)
        if (xhr.status >= 200 && xhr.status < 300) return JSON.parse(xhr.responseText)
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    /**
     * 异步 POST JSON；返回 Promise<object|null>，永不 reject。
     * @param {string} path 路由路径。
     * @param {object} payload 请求体。
     * @param {number} [timeoutMs] 可选超时（v1.1.0）：超时 abort 并按失败结算，
     *   绝不让请求悬空（A→B 注入必须用它，否则宿主卡住时界面毫无反应）。
     */
    function postJson(path, payload, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false
        const done = (v) => {
          if (settled) return
          settled = true
          resolve(v)
        }
        try {
          const xhr = new XMLHttpRequest()
          let timer = null
          if (Number(timeoutMs) > 0) {
            timer = window.setTimeout(function () {
              try {
                xhr.abort()
              } catch (err) {
                /* 忽略 */
              }
              done({ ok: false, reason: 'timeout', detail: '请求宿主超时（' + timeoutMs + 'ms 无响应）' })
            }, Number(timeoutMs))
          }
          xhr.open('POST', path, true)
          xhr.setRequestHeader('Content-Type', 'application/json')
          xhr.onload = () => {
            if (timer) window.clearTimeout(timer)
            try {
              done(JSON.parse(xhr.responseText || '{}'))
            } catch (err) {
              done({ ok: xhr.status >= 200 && xhr.status < 300, detail: '响应无法解析（HTTP ' + xhr.status + '）' })
            }
          }
          xhr.onerror = () => {
            if (timer) window.clearTimeout(timer)
            done({ ok: false, reason: 'network', detail: '请求失败（宿主路由不可达）' })
          }
          xhr.onabort = () => {
            if (timer) window.clearTimeout(timer)
            // 超时触发的 abort 结果已由定时器给出；这里只兜底，不覆盖
            done({ ok: false, reason: 'timeout', detail: '请求已中止' })
          }
          xhr.send(JSON.stringify(payload || {}))
        } catch (err) {
          done({ ok: false, detail: String((err && err.message) || err) })
        }
      })
    }

    // ─────────────────────────── 配置快照 ───────────────────────────
    let config = {
      url: 'https://chat.deepseek.com',
      placement: 'over-dsh',
      sidebarInset: 268,
      gap: 10,
      minWidth: 520,
      minHeight: 460,
      browser: null,
      profileDir: '',
      // 上下文接力（宿主 config.json 会覆盖这几个默认值）
      relay: true,
      // ⚠️ 必须与宿主 index.js 的 DEFAULTS.relayPrefix **完全一致**：
      //    两边文案不同时，去重判断（"开头是不是我这条前缀"）永远不成立，
      //    结果每次接力都多贴一整块「前缀 + 空行」—— 现场就是「大量空白」。
      relayPrefix: '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】',
      // A→B（DSH 划词传给 Chat）用的前缀
      transferPrefix: '【来自 DSH 上下文】\n\n',
      relayButtonText: '↪ 转到 DSH 继续',
      relayBodySelector: '',
      relayIncludeThread: false,
      relayMaxChars: 2000,
      // 网页端脚本读的是这个名字（page-script.js 的 CFG.maxChars）。
      // 以前这里只有 relayMaxChars，导致网页端拿不到值、退回到 20000 的内置默认值 ——
      // 长文本一路灌进 DSH 输入框，就是「卡顿 + 大面积空白」的来源之一。
      maxChars: 2000,
      // B→A 分支：网页端「↪ 分支到 DSH」带回的整段上下文（宿主 config.json 会覆盖）
      branchMaxChars: 5000,
      // A→B 气泡触发方式（v1.5.0 默认 'select'，v1.6.0 改为 'modifier'）：
      //   'modifier'（**新默认**）—— 必须「按住修饰键划词」或「先划词、再按修饰键」才冒泡。
      //                  普通划词（复制、搜索、查看）一律不打扰 —— 这是 v1.6.0 的核心。
      //   'contextmenu'      —— 对选区右键时才冒泡（DSH 自带右键菜单照常并存）。
      //   'select'           —— 旧行为：划词松手就冒泡。**仍受排除区约束**（输入框/代码块/
      //                        按钮/菜单/侧栏里绝不冒），但普通正文里依然会打扰，仅供回退。
      //   'off'              —— 完全关闭气泡（快捷键 Ctrl+Shift+S 仍可用）。
      // 宿主 config.json 会覆盖这个默认值。
      bubbleTrigger: 'modifier',
      // 'modifier' 模式下用哪个修饰键：'alt'（默认）/ 'ctrl' / 'shift' / 'meta'。
      // ⚠️ Windows 上 Alt 在部分壳层会激活菜单栏，故 modifier 模式**同时**支持
      //    「先划词、再按修饰键」这条路径 —— 单独按一下修饰键不会有任何副作用。
      bubbleModifier: 'alt',
      // 'modifier' 模式下：划完词后按修饰键，气泡的「待命窗口」有多长（毫秒）。
      // 超时后再按修饰键不冒泡 —— 防止很久以前的选区被误当成新划的词。
      bubbleArmWindow: 4000,
      // 气泡无操作自动消失的时间（毫秒）。0 = 不自动消失。
      // 有这个兜底，气泡就算被什么奇怪路径残留，也不可能长期压在输入框上。
      bubbleAutoHideMs: 6000,
      // 划词气泡的准入范围：
      //   'input-excluded'（默认）—— 只排除「明确的非正文区」（输入框/代码块/按钮/菜单/
      //                        侧栏/表格/弹窗…）。语义标签稳定，DSH 改版也不会失效。
      //   'conversation'         —— 更严：额外要求选区落在「看起来像对话正文」的容器里。
      //                        DSH 的 class 名是构建期生成的，一旦升版可能对不上，
      //                        因此只作为可选档，不做默认。
      bubbleScope: 'input-excluded',
      // A→B 快捷键直发（v1.4.0）：划词后按此组合键直接发送，物理绕开「点气泡」
      // 整条指针链路（DSH 0.20.0 壳层吞指针事件的问题从此与发送无关）。
      // 空字符串 = 禁用快捷键。宿主 config.json 可覆盖。
      hotkeySend: 'ctrl+shift+s',
    }
    const remote = getJson(`${BASE}/config.json`)
    if (remote && typeof remote === 'object') config = Object.assign(config, remote)
    diag('config.browser = ' + String(config.browser))
    diag('config.profileDir = ' + String(config.profileDir))

    // ─────────────────────────── 模式持久化 ───────────────────────────
    function readMode() {
      try {
        const v = window.localStorage.getItem(STORAGE_KEY)
        if (v === MODE_WEB || v === MODE_DSH) return v
      } catch (err) {
        /* 隐私模式等场景下 localStorage 可能不可用 */
      }
      return MODE_DSH
    }

    function writeMode(mode) {
      try {
        window.localStorage.setItem(STORAGE_KEY, mode)
      } catch (err) {
        /* 忽略 */
      }
    }

    // ─────────────────── 计算 DSH 窗口内容区矩形 ───────────────────
    /**
     * 给宿主用来把 DeepSeek 窗口摆到「DSH 窗口的内容区」上，
     * 视觉上就像嵌在 DSH 里。
     *
     * 坐标系与单位：CSS px。Chromium 的 --window-position / --window-size 用的
     * 也是 DIP，两者一致，不需要 DPR 换算。
     *
     * @returns {{x:number,y:number,w:number,h:number}|null} 内容区矩形。
     */
    function contentRect() {
      try {
        const ow = Number(window.outerWidth) || 0
        const oh = Number(window.outerHeight) || 0
        const iw = Number(window.innerWidth) || 0
        const ih = Number(window.innerHeight) || 0
        if (!iw || !ih) return null
        // 原生标题栏/边框占掉的量
        const chromeW = Math.max(0, ow - iw)
        const chromeH = Math.max(0, oh - ih)
        return {
          x: (Number(window.screenX) || 0) + chromeW / 2,
          y: (Number(window.screenY) || 0) + chromeH,
          w: iw,
          h: ih,
        }
      } catch (err) {
        return null
      }
    }

    // ─────────────────── 打开网页端：Tauri 快路径 + 兜底 ───────────────────
    /**
     * 如果启动器把 Tauri 的全局 JS API 暴露给了页面（withGlobalTauri），
     * 就用原生 WebviewWindow —— 集成度最高。
     *
     * 但请注意：DSH 本体并不依赖 Tauri（它要能跑在普通浏览器里），所以这条路
     * 大概率不存在。这里只是「有就用，没有就换路」，不影响功能。
     *
     * @returns {{ok:boolean, detail:string}|null} null 表示这条路不可用。
     */
    function tryTauriOpen() {
      try {
        const t = window.__TAURI__
        const api = t && t.webviewWindow
        const WW = api && api.WebviewWindow
        if (typeof WW !== 'function') return null
        const existing = typeof api.getByLabel === 'function' ? api.getByLabel('deepseek-web-relay') : null
        if (existing) {
          if (typeof existing.setFocus === 'function') existing.setFocus()
          return { ok: true, detail: '已聚焦既有的 Tauri 窗口' }
        }
        // eslint-disable-next-line no-new
        new WW('deepseek-web-relay', {
          url: config.url,
          title: 'DeepSeek',
          width: 1000,
          height: 760,
        })
        return { ok: true, detail: '已创建 Tauri WebviewWindow' }
      } catch (err) {
        return { ok: false, detail: 'Tauri 路径失败: ' + String((err && err.message) || err) }
      }
    }

    /**
     * 打开 DeepSeek 窗口。优先 Tauri，其次交给宿主半端起独立浏览器窗口。
     * @returns {Promise<{ok:boolean, detail:string, mode?:string}>} 结果。
     */
    async function openWeb() {
      const tauri = tryTauriOpen()
      if (tauri && tauri.ok) {
        diag('open: tauri 路径成功')
        return tauri
      }
      if (tauri) diag('open: ' + tauri.detail + ' → 回退到独立浏览器窗口')

      const rect = contentRect()
      const result = await postJson(`${BASE}/open`, { rect })
      diag('open -> ' + JSON.stringify(result))
      return result || { ok: false, detail: '宿主无响应' }
    }

    /** 关闭网页端窗口（切回 DSH 默认模式时调用）。 */
    function closeWeb() {
      return postJson(`${BASE}/close`, {})
    }

    // ─────────────────────────── 样式 ───────────────────────────
    const CSS = `
.dsw-brand{display:flex;align-items:center;gap:2px;min-width:0;flex:1}
/* ⚠️ 不能给 .dsw-brand-identity 加 flex:1 / overflow:hidden：开关按钮现在放在它内部，
   overflow:hidden 会把按钮裁掉。让它按内容取自然宽度。 */
.dsw-brand-identity{display:flex;align-items:center;gap:6px;min-width:0}
/* 旧的顶部开关按钮样式：v1.7 起已不再渲染（改由左侧边栏原生菜单项承担切换）。
   保留这几条只为兼容可能残留的旧节点，新代码不产生 .dsw-brand-toggle。 */
.dsw-brand-toggle{flex:none;display:flex!important;align-items:center;justify-content:center;
  width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-secondary,#6b7280);transition:background .12s ease}
.dsw-brand-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.07))}
.dsw-brand-toggle svg{transition:transform .15s ease}
.dsw-brand-toggle[data-open="1"] svg{transform:rotate(180deg)}
/* 左侧菜单项的图标：DSH 会把它放进自己的行按钮里，这里只保证可点、颜色跟随主题 */
.dsw-panel-glyph{display:inline-flex;align-items:center;justify-content:center;
  width:100%;height:100%;cursor:pointer;color:inherit}

/* 菜单：固定定位、贴着按钮正下方展开；宽度由 JS 按侧边栏宽度和视口宽度算好后内联给出，
   所以这里只兜底一个最小/最大值，并加上 max-height 防止在小窗口里竖向也溢出。 */
.dsw-menu{position:fixed;z-index:2147483000;min-width:200px;max-width:340px;
  max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain;
  box-sizing:border-box;
  padding:5px;border-radius:10px;display:flex;flex-direction:column;gap:1px;
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-label-primary,#1b1f24);
  border:1px solid var(--dsw-alias-border-l2,#d7dbe0);
  box-shadow:0 12px 32px rgba(0,0,0,.18);
  font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}
.dsw-menu-label{padding:6px 10px 3px;font-size:11px;letter-spacing:.02em;
  color:var(--dsw-alias-label-tertiary,#8b95a5)}
.dsw-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;
  border:0;border-radius:7px;background:transparent;cursor:pointer;text-align:left;
  color:inherit;font:inherit}
.dsw-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}
.dsw-item[data-on="1"]{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.dsw-item-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsw-item-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 描述允许换行 —— 之前是 nowrap + ellipsis，长描述会被截成「登录态持久…」，
   看起来像被窗口切掉，其实是这里截的。 */
.dsw-item-desc{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b95a5);
  white-space:normal;overflow-wrap:anywhere;line-height:1.45}
.dsw-item-check{flex:none;width:16px;display:flex;align-items:center;justify-content:center;
  color:var(--dsw-alias-label-primary,#1b1f24)}
/* 图标槽固定 18×18；里面两个 logo 用同一个类，尺寸只在这一处定义，
   保证「完全一样大」，不会因为组件传参不同而不一致。 */
.dsw-item-mark{flex:none;width:18px;height:18px;display:flex;align-items:center;justify-content:center}
.dsw-logo{display:block;flex:none}
.dsw-item-mark .dsw-logo{width:18px;height:18px}
/* 菜单的深色适配（v1.7 起菜单本身不再渲染，这几条只兜可能残留的旧节点） */
html.dsh-deepseek-dark .dsw-menu{background:rgba(30,30,30,.97);color:#E5E7EB;
  border-color:rgba(255,255,255,.14)}
html.dsh-deepseek-dark .dsw-menu-label{color:#9ca3af}
html.dsh-deepseek-dark .dsw-item:hover,
html.dsh-deepseek-dark .dsw-item[data-on="1"]{background:rgba(255,255,255,.08)}
@media (prefers-color-scheme: dark){
  html:not(.dsh-deepseek-light) .dsw-menu{background:rgba(30,30,30,.97);color:#E5E7EB;
    border-color:rgba(255,255,255,.14)}
  html:not(.dsh-deepseek-light) .dsw-menu-label{color:#9ca3af}
  html:not(.dsh-deepseek-light) .dsw-item:hover,
  html:not(.dsh-deepseek-light) .dsw-item[data-on="1"]{background:rgba(255,255,255,.08)}
}

/* ── 划词气泡「🐋 传给Chat」：浮在选区正上方 ──
   ⚠️ 颜色不再依赖站点变量（深色/自定义主题下曾出现低对比、文字看不清）：
      浅色为默认；深色由 <html>.dsh-deepseek-dark（JS 探测，见 setupDswThemeWatch）
      或系统偏好 @media 兜底切换，黑白背景下对比度都在 9:1 以上。 */
.dsw-bubble{position:fixed;z-index:2147483002;transform:translate(-50%,-100%);
  padding:7px 16px;border-radius:999px;cursor:pointer;white-space:nowrap;user-select:none;
  pointer-events:auto;
  background:#fff;color:#111827;border:1px solid #d7dbe0;
  box-shadow:0 6px 18px rgba(0,0,0,.16);
  font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
/* v1.5.0 宽容命中光环：药丸本体外扩 22px 的透明可点区 —— 点光环任意位置都
   算点中气泡（事件 target 仍是按钮，onDown 守卫/发送监听全部自然生效）。
   现场数据：用户多次按偏 20~160px，旧小药丸 + 「按下即销毁」= 点偏一次气泡就
   消失，观感就是「点了没反应、要连点好几下」。 */
.dsw-bubble::after{content:'';position:absolute;left:-22px;top:-18px;right:-22px;bottom:-18px}
.dsw-bubble:hover{background:#f3f4f6}
/* v1.6.0：气泡不再长期滞留 —— 加一层极短的淡入淡出，让「它会自己消失」这件事
   在视觉上可预期；配合 JS 的 bubbleAutoHideMs 自动收起。 */
.dsw-bubble{animation:dswBubbleIn .12s ease-out}
@keyframes dswBubbleIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion: reduce){.dsw-bubble{animation:none}}
/* 深色：JS 探测挂的标记 */
html.dsh-deepseek-dark .dsw-bubble{background:rgba(30,30,30,.95);color:#E5E7EB;
  border-color:rgba(255,255,255,.14);box-shadow:0 6px 18px rgba(0,0,0,.45)}
html.dsh-deepseek-dark .dsw-bubble:hover{background:rgba(48,48,50,.97)}
/* 深色：系统偏好兜底（JS 探测没结论时也能对） */
@media (prefers-color-scheme: dark){
  html:not(.dsh-deepseek-light) .dsw-bubble{background:rgba(30,30,30,.95);color:#E5E7EB;
    border-color:rgba(255,255,255,.14);box-shadow:0 6px 18px rgba(0,0,0,.45)}
  html:not(.dsh-deepseek-light) .dsw-bubble:hover{background:rgba(48,48,50,.97)}
}

/* ── 上下文接力的小提示（浮动在右下角，几秒后自动消失）── */
.dsw-toast{position:fixed;right:20px;bottom:20px;z-index:2147483001;max-width:420px;
  padding:10px 14px;border-radius:10px;pointer-events:none;
  font:12.5px/1.6 system-ui,"Microsoft YaHei",sans-serif;
  background:#fff;color:#111827;border:1px solid #d7dbe0;
  box-shadow:0 10px 28px rgba(0,0,0,.18);word-break:break-word;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.dsw-toast[data-err="1"]{border-color:#e2a03f;color:#9a5b00}
html.dsh-deepseek-dark .dsw-toast{background:rgba(30,30,30,.95);color:#E5E7EB;
  border-color:rgba(255,255,255,.14);box-shadow:0 10px 28px rgba(0,0,0,.5)}
html.dsh-deepseek-dark .dsw-toast[data-err="1"]{border-color:#f0a13e;color:#fbbf24}
@media (prefers-color-scheme: dark){
  html:not(.dsh-deepseek-light) .dsw-toast{background:rgba(30,30,30,.95);color:#E5E7EB;
    border-color:rgba(255,255,255,.14);box-shadow:0 10px 28px rgba(0,0,0,.5)}
  html:not(.dsh-deepseek-light) .dsw-toast[data-err="1"]{border-color:#f0a13e;color:#fbbf24}
}
`

    let styleInjected = false
    function ensureStyle() {
      if (styleInjected) return
      styleInjected = true
      try {
        const el = document.createElement('style')
        el.setAttribute('data-dsh-deepseek-web-relay', '')
        el.textContent = CSS
        document.head.appendChild(el)
      } catch (err) {
        /* 样式注入失败不影响功能，只是难看一点 */
      }
    }

    // ─────────────── 主题自适应：深浅色探测（v1.1.0 修复深色模式看不清）───────────────
    //
    // DSH 的 --dsw-alias-* 变量在深色 / 自定义主题下对浮层不可靠（现场：提示气泡
    // 和 Toast 文字与背景对比度极低）。改为 JS 主动探测主题，在 <html> 上挂
    // dsh-deepseek-dark / dsh-deepseek-light 标记，CSS 按标记切配色；
    // 系统偏好 @media 作为 JS 探测失灵时的兜底。
    //
    // 判据优先级：① DSH 主题标记（class / data-theme）→ ② DSH 的表面色变量
    // --dsw-alias-bg-elevated → ③ 页面实际背景亮度 → ④ 系统偏好。
    let dswThemeSetup = false

    function detectDswTheme() {
      try {
        const root = document.documentElement
        const body = document.body
        // ① DSH 的主题标记
        try {
          const attr = String(
            (root && (root.getAttribute('data-theme') || root.getAttribute('data-color-scheme'))) ||
              (body && (body.getAttribute('data-theme') || body.getAttribute('data-color-scheme'))) ||
              '',
          )
          if (attr.toLowerCase().includes('dark')) return 'dark'
          const cls =
            String((root && root.className) || '') + ' ' + String((body && body.className) || '')
          if (/(^|\s)(dark|theme-dark|dark-theme)(\s|$)/.test(cls)) return 'dark'
        } catch (err) {
          /* 忽略 */
        }
        // ② DSH 自己的表面色变量（自定义主题往往只改这些值）
        try {
          const v = String(
            getComputedStyle(root).getPropertyValue('--dsw-alias-bg-elevated') || '',
          ).trim()
          let r = -1
          let g = -1
          let b = -1
          const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v)
          const h = /^#([0-9a-f]{6})$/i.exec(v)
          if (m && (m[4] === undefined || Number(m[4]) >= 0.5)) {
            r = Number(m[1])
            g = Number(m[2])
            b = Number(m[3])
          } else if (h) {
            const n = parseInt(h[1], 16)
            r = (n >> 16) & 255
            g = (n >> 8) & 255
            b = n & 255
          }
          if (r >= 0) {
            const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            return lum < 128 ? 'dark' : 'light'
          }
        } catch (err) {
          /* 忽略 */
        }
        // ③ 页面实际背景亮度（对自定义主题最可靠）
        try {
          let node = body
          for (let i = 0; i < 4 && node && node.nodeType === 1; i++) {
            const bg = String(getComputedStyle(node).backgroundColor || '')
            const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(bg)
            if (m) {
              const a = m[4] === undefined ? 1 : Number(m[4])
              if (a >= 0.5) {
                const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])
                return lum < 128 ? 'dark' : 'light'
              }
            }
            node = node.parentElement
          }
        } catch (err) {
          /* 忽略 */
        }
        // ④ 系统偏好
        try {
          if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return 'dark'
          }
        } catch (err) {
          /* 忽略 */
        }
        return 'light'
      } catch (err) {
        return 'light'
      }
    }

    function applyDswTheme() {
      try {
        const t = detectDswTheme()
        const root = document.documentElement
        root.classList.toggle('dsh-deepseek-dark', t === 'dark')
        root.classList.toggle('dsh-deepseek-light', t === 'light')
      } catch (err) {
        /* 探测失败就交给 CSS 的系统偏好兜底 */
      }
    }

    /** 探测一次 + 盯住主题切换（DSH 切深浅色 / 换皮肤时自动跟随）。 */
    function setupDswThemeWatch() {
      if (dswThemeSetup) return
      dswThemeSetup = true
      applyDswTheme()
      try {
        const obs = new MutationObserver(function () {
          applyDswTheme()
        })
        obs.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'data-color-scheme'],
        })
        const attachBody = function () {
          try {
            if (document.body) {
              obs.observe(document.body, {
                attributes: true,
                attributeFilter: ['class', 'data-theme', 'data-color-scheme'],
              })
              applyDswTheme()
            }
          } catch (err) {
            /* 忽略 */
          }
        }
        if (document.body) attachBody()
        else document.addEventListener('DOMContentLoaded', attachBody, { once: true })
      } catch (err) {
        /* 观察器挂不上：初始那次 applyDswTheme 已经生效，后续靠重渲染 */
      }
      try {
        if (window.matchMedia) {
          const mq = window.matchMedia('(prefers-color-scheme: dark)')
          const onChange = function () {
            applyDswTheme()
          }
          if (mq.addEventListener) mq.addEventListener('change', onChange)
          else if (mq.addListener) mq.addListener(onChange)
        }
      } catch (err) {
        /* 忽略 */
      }
    }

    setupDswThemeWatch()

    /** 勾选标记。 */
    function CheckIcon() {
      return React.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M20 6L9 17l-5-5' }),
      )
    }

    /** 下拉箭头。 */
    function ChevronDown() {
      return React.createElement(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('path', { d: 'M6 9l6 6 6-6' }),
      )
    }

    // ─────────────────── 官方品牌图标（均为真实 Logo 矢量） ───────────────────
    //
    // 两个图标都不是手画的，来源都可靠：
    //
    // 1) DSH 鲸鱼（黑）
    //    运行时从 DSH 自己的种子模块 @deepseek-ai/dsh-client-ui-primitives 读
    //    FISH_LOGO_PATH / FISH_LOGO_VIEWBOX —— 这与侧边栏品牌行 fallback 用的
    //    FishLogo 是**同一份官方路径**。取不到时回退到 DSH 自己的 favicon.svg
    //    （dsh-web-frontend/dist/favicon.svg，viewBox "0 0 50 50"）。
    //    填充用 currentColor：浅色主题下即黑色，深色主题下自动变白 —— 这正是
    //    DSH favicon 自身的做法，避免深色主题里黑鲸鱼看不见。
    //
    // 2) DeepSeek 鲸鱼（蓝）
    //    官方 DeepSeek 图标，品牌蓝 #4D6BFE。固定品牌色，不跟随主题。
    //    矢量来源：Wikimedia Commons "Deepseek-logo-icon.svg"（CC0 公有领域，
    //    https://commons.wikimedia.org/wiki/File:Deepseek-logo-icon.svg ）。
    //    这里只取鲸鱼本体那一条 path，去掉了原图的白底圆角方块，
    //    这样在深色主题下也不会出现一块白底。
    const DSH_WHALE_FALLBACK_PATH =
      'M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z'
    const DSH_WHALE_FALLBACK_VIEWBOX = '0 0 50 50'

    const DEEPSEEK_WHALE_PATH =
      'M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-.801.612-1.479 1.407-2.154 2.141-5.848 6.246-12.681 10.349-21.607 9.859-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-5.54-2.449-11.141-4.9-15.02-10.227-2.708-3.795-3.447-8.021-4.801-12.185-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082-1.293 4.41-2.832 8.695-4.186 13.105-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-13.481-13.044-25.668-27.434-40.873-38.702a177.614 177.614 0 00-10.834-7.409c-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-13.727.061-26.285 4.653-42.288 10.777-2.34.92-4.801 1.593-7.326 2.142-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245v-.003zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676zm15.899-102.519c.521-2.111 2.421-3.658 4.722-3.658a4.74 4.74 0 011.661.305c.678.246 1.293.614 1.786 1.163.861.859 1.354 2.083 1.354 3.368 0 2.695-2.154 4.837-4.862 4.837a4.748 4.748 0 01-4.738-4.034 5.01 5.01 0 01.077-1.981zm47.208 26.915c-2.606.996-5.2 1.778-7.707 1.88-4.679.244-9.787-1.654-12.556-3.981-4.308-3.612-7.386-5.631-8.679-11.941-.554-2.695-.247-6.858.246-9.246 1.108-5.144-.124-8.451-3.754-11.451-2.954-2.449-6.711-3.122-10.834-3.122-1.539 0-2.954-.673-4.001-1.224-1.724-.856-3.139-3-1.785-5.634.432-.856 2.525-2.939 3.018-3.305 5.6-3.185 12.065-2.144 18.034.244 5.54 2.266 9.727 6.429 15.759 12.307 6.155 7.102 7.263 9.063 10.773 14.39 2.771 4.163 5.294 8.451 7.018 13.348.877 2.561.071 4.74-2.341 6.277-.981.625-2.109 1.044-3.191 1.458z'
    const DEEPSEEK_WHALE_VIEWBOX = '0 0 512 509.64'
    const DEEPSEEK_BRAND_BLUE = '#4D6BFE'

    // ── 把图标放大到「填满自己的框」──
    //
    // 实测过的问题：两个图标给的都是 width/height=16 的正方框，但**画出来的实际大小差 1.6 倍**：
    //   DSH 鲸鱼   viewBox "0 0 50 50"，而路径包围盒只有 23.16×17.04，还画在左上角
    //              → 换算到屏幕上只有 7.41×5.45 px
    //   DeepSeek   viewBox "0 0 512 509.64"，路径包围盒 377.72×277.97
    //              → 屏幕上是 11.8×8.73 px
    //
    // 解法：不用别人给的 viewBox，而是**把 viewBox 设成路径自己的紧致包围盒**。
    // 这样两条鲸鱼都会填满同一个正方框；而且巧的是它俩本来就是同一条鲸鱼，
    // 长宽比几乎一致（1.359 vs 1.359），所以缩放后**大小完全相同**。
    //
    // 包围盒用 SVG 自己的 getBBox() 现算一次（结果缓存），不写死数字 ——
    // 将来 DSH 换了路径也不用改这里。
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const tightBoxCache = new Map()

    /**
     * 求一条 SVG path 的紧致包围盒，返回可直接当 viewBox 用的字符串。
     * @param {string} d 路径数据。
     * @param {string} fallback 算不出来时的兜底 viewBox。
     * @returns {string} "x y w h"。
     */
    function tightViewBox(d, fallback) {
      if (tightBoxCache.has(d)) return tightBoxCache.get(d)
      let vb = fallback
      try {
        const svg = document.createElementNS(SVG_NS, 'svg')
        svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none')
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', d)
        svg.appendChild(path)
        document.body.appendChild(svg)
        const bb = path.getBBox()
        document.body.removeChild(svg)
        if (bb && bb.width > 0 && bb.height > 0) {
          vb = bb.x + ' ' + bb.y + ' ' + bb.width + ' ' + bb.height
        }
      } catch (err) {
        /* 算不出来就用兜底 viewBox（至少不会崩） */
      }
      tightBoxCache.set(d, vb)
      return vb
    }

    /** 两个图标共用的边长（保证「完全一样大」只有一个来源）。 */
    const LOGO_SIZE = 18

    /** DSH 官方鲸鱼（黑）：优先用运行时种子模块里的官方路径，取不到就用 favicon 兜底。 */
    function DshWhaleLogo(props) {
      const size = (props && props.size) || LOGO_SIZE
      const p =
        (primitives && typeof primitives.FISH_LOGO_PATH === 'string' && primitives.FISH_LOGO_PATH) ||
        DSH_WHALE_FALLBACK_PATH
      return React.createElement(
        'svg',
        {
          className: 'dsw-logo',
          width: size,
          height: size,
          viewBox: tightViewBox(p, DSH_WHALE_FALLBACK_VIEWBOX),
          preserveAspectRatio: 'xMidYMid meet',
          fill: 'currentColor',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: p }),
      )
    }

    /** DeepSeek 官方鲸鱼（品牌蓝 #4D6BFE）：固定品牌色，不跟随主题。 */
    function DeepSeekWhaleLogo(props) {
      const size = (props && props.size) || LOGO_SIZE
      return React.createElement(
        'svg',
        {
          className: 'dsw-logo',
          width: size,
          height: size,
          viewBox: tightViewBox(DEEPSEEK_WHALE_PATH, DEEPSEEK_WHALE_VIEWBOX),
          preserveAspectRatio: 'xMidYMid meet',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', { d: DEEPSEEK_WHALE_PATH, fill: DEEPSEEK_BRAND_BLUE }),
      )
    }

    // ─────────────────── 上下文接力：接收 + 写进输入框 ───────────────────
    //
    // 链路：网页端点按钮 → CDP → 宿主半边入队 → 这里每 1.5 秒取走 → setDraft
    //
    // ⚠️ 为什么不直接改输入框的 DOM：
    // DSH 的输入框是 Lexical 富文本编辑器，直接改 DOM 会被它下一次渲染冲掉。
    // 官方给**每个 session 作用域组件**提供了一个动作面 InputActions，里面的
    // setDraft(text) 就是「程序化写草稿」的正路。
    //
    // 挂载点选 `conversation.session.header.utilities`：它是 kind:"list" 的
    // session 作用域 slot —— list 是「追加」语义，不会顶掉别人的东西
    // （对比：sidebar.brand.name 是 single，必须靠 priority 抢）。

    /** DSH 官方输入动作面（含 setDraft）。由 RelayBridge 在渲染时抓住。 */
    let sessionInput = null
    /** 只上报一次「桥上到底收到了什么 props」，用于确认 DSH 是否真给了 inputActions。 */
    let relayPropsLogged = false

    // 极小的 toast 订阅器：让提示能在任意时刻冒出来，不必把状态挂在组件树上
    let toastValue = null
    const toastSubs = new Set()

    function showToast(text, isError) {
      try {
        const mine = { text: String(text), isError: Boolean(isError) }
        toastValue = mine
        for (const fn of toastSubs) {
          try {
            fn(mine)
          } catch (err) {
            /* 忽略 */
          }
        }
        window.setTimeout(() => {
          if (toastValue === mine) {
            toastValue = null
            for (const fn of toastSubs) {
              try {
                fn(null)
              } catch (err) {
                /* 忽略 */
              }
            }
          }
        }, 4500)
      } catch (err) {
        /* 提示失败不影响主流程 */
      }
    }

    // ─────────────────── A→B：DSH 划词 → 传给 Chat ───────────────────
    //
    // 交互：在 DSH 里选中一段文字、松开鼠标 → 选区上方冒一个小气泡
    //       「🐋 传给Chat」→ 点它 → 带前缀发给宿主 → 宿主经 CDP 注入网页端输入框，
    //       并把网页端窗口切到前台。注入失败则兜底复制到剪贴板。

    // ─────────────────── 文本清洗（与 page-script.js 里那份**必须一致**）───────────────────
    //
    // 现场问题：划词带走的内容混着 不间断空格(U+00A0)、字面量 `&nbsp;`、CRLF、
    // 以及一大串连续换行；注入到对方输入框后变成「特别大且不正常的空格」。
    //
    // ⚠️ 顺序不能换：先把 CRLF/CR 归一成 \n，再压连续换行 ——
    //    否则 `\r\n\r\n\r\n` 匹配不上 /\n{3,}/，压缩会失效。
    // 📌 有意不动行内的多个普通空格（代码缩进 / markdown 对齐）。
    //
    // 🔒 安全约束（上一版把界面改死过，这一版必须守住）：
    //    · 任何文本进函数第一行先做类型判断，绝不出现 null.replace；
    //    · 整个清洗体包在 try/catch 里，出错就原样返回，绝不让异常冒到渲染路径；
    //    · 只用最简单的 /g 全局替换，无回溯、无循环、无状态，不可能死循环；
    //    · 返回的必然是字符串，调用方无需再判类型。
    const CLEAN_VERSION = 'clean-text-v3-trunc2000'
    /**
     * 互传文本的字符上限。**硬截断**：抓取到文本后立刻切掉超出部分。
     * 目的：任何一条互传内容都不会长到把 DSH 输入框 / IPC 拖死。
     */
    const TRANSFER_MAX_CHARS = 2000

    /**
     * DSH 输入框里草稿的**总长上限**。接力是「追加」语义，但没有上限时草稿会一直涨，
     * 而 DSH 输入框是随内容自动长高的 —— 长到一定程度就把窗口顶满、滚不回去，
     * 用户看到的就是「输入框变得很大，恢复不了」。超过这个上限时从头裁掉最老的内容，
     * 永远保住最新一条接力。
     */
    const DSH_DRAFT_MAX = 6000

    /**
     * 安全清洗「互传文本」：把所有会显示成「异常大空格」的字符归一到普通字符。
     * 抓取（划词）后与注入（写输入框）前都必须过一遍；本函数幂等，重复调用无害。
     *
     * @param {string} text 待清洗文本。
     * @param {number} [capOverride] 可选截断上限（v1.1.0）：分支上下文用
     *   branchMaxChars（默认 5000），比划词的 2000 宽；不传/非法时维持 2000。
     * @returns {string} 清洗后的字符串（已截到上限以内；入参非法返回 ''，绝不抛错）。
     */
    function safeCleanText(text, capOverride) {
      // 1) 第一行就挡空值：绝不允许 null.replace / undefined.replace 冒到全局
      if (!text || typeof text !== 'string') return text || ''
      // 2) 立刻硬截断（在清洗之前做，后面的活儿永远只处理短文本）
      const cap = Number(capOverride) > 0 ? Math.round(Number(capOverride)) : TRANSFER_MAX_CHARS
      const cut = text.length > cap ? text.slice(0, cap) : text
      try {
        let t = cut
        // 3) 所有换行风格先归一成 LF（必须最先做）
        t = t.replace(/\r\n/g, '\n') // Windows 换行 → LF
        t = t.replace(/\r/g, '\n') // 裸 CR（Mac / 站点自定义换行）→ LF
        // 4) 会显示成「大空格」的各种空白字符
        t = t.replace(/\u00A0/g, ' ') // 不间断空格 NBSP → 普通空格
        t = t.replace(/&nbsp;/g, ' ') // 字面量 HTML 实体 → 普通空格
        t = t.replace(/[\u200B\uFEFF]/g, '') // 零宽空格 / BOM → 删掉（v1 就有，别丢）
        // 5) 行尾空白：行尾的空格/制表符在输入框里就是「看不见的空档」
        t = t.replace(/[ \t]+\n/g, '\n')
        // 6) 连续 3 个以上换行 → 2 个（巨大空白的直接元凶）
        t = t.replace(/\n{3,}/g, '\n\n')
        // 7) 去掉首尾无用空白
        return t.trim()
      } catch (e) {
        // 清洗失败就原样返回（注意返回的是**已截断**的 cut）：
        // 宁可留一点空格，也绝不让页面报错/卡死，更不能把超长文本放回去。
        console.error('清洗失败', e)
        return cut
      }
    }

    /** 兼容旧名：本文件内所有调用点都指向同一份安全清洗。 */
    const cleanTransferText = safeCleanText

    /**
     * 读取当前选中的纯文本，并算出气泡该出现在哪；没有有效选区就返回 null。
     * 📋 每个拒绝分支都记进 lastSelReject（DshOverlay 上报 bubble-none 用）——
     *    2026-10-01 排查「传送没反应」时发现：气泡没出现和点了没反应在日志里
     *    长得一模一样，必须区分。
     * @returns {{text:string,left:number,top:number}|null} 气泡数据。
     */
    let lastSelReject = ''
    let lastBubbleNoneAt = 0
    /** 气泡「点了却被守卫挡住」最近一次上报时刻（bubble-blocked 埋点节流用）。 */
    let lastBlockedAt = 0
    /** 气泡存活但点击落在外面（bubble-miss 距离埋点）最近一次上报时刻。 */
    let lastMissReportAt = 0

    /**
     * 读选区文本（含 Shadow DOM 兜底，v1.2.0）。
     * 🐞 DSH 0.20.0 部分渲染区域在 ShadowRoot 里：那种选区对 window.getSelection()
     *    表现为 collapsed、toString() 为空 —— v1.2.0 的 selectionchange 缓存
     *    跟着失灵，留下「偶发 collapsed 失败」的漏网（10-31 现场：一次成功
     *    注入后 4 秒，同样的划法只报 collapsed）。Chrome/Edge ≥134 的
     *    getComposedRanges() 能穿透 shadow 边界拿到真实 range，这里做兜底。
     * @param {Selection} sel window.getSelection() 的结果。
     * @returns {{text:string, range:(Range|null)}} 文本与首选 range（算锚点用）。
     */
    function selTextWithComposed(sel) {
      let range = null
      try {
        if (sel.rangeCount > 0) range = sel.getRangeAt(0)
      } catch (err) {
        range = null
      }
      let text = ''
      try {
        // 只认 toString()：绝不碰 innerHTML / cloneContents（那会把标签和实体带出来）
        text = sel.toString()
      } catch (err) {
        text = ''
      }
      if (!text && typeof sel.getComposedRanges === 'function') {
        try {
          const ranges = sel.getComposedRanges()
          let composed = ''
          let first = null
          for (const r of ranges || []) {
            if (!first) first = r
            try {
              composed += r.toString()
            } catch (err) {
              /* 单个 range 坏了跳过 */
            }
          }
          if (composed) {
            text = composed
            if (!range) range = first
          }
        } catch (err) {
          /* 老内核没有该 API，维持空文本 */
        }
      }
      return { text: text, range: range }
    }

    // ─────────────── v1.6.0：划词准入判定（气泡只在对的地方冒）───────────────
    //
    // 🐞 为什么不能靠「排除插件市场/设置」这种方式写死路径：
    //    DSH 是 React 应用，class 名基本是构建期生成的（v1.2.0 踩过的坑：
    //    部分渲染区在 ShadowRoot 里），插件市场这种页面的类名会随版本变。
    //    所以这里的策略是**按语义排除**，而不是按路径排除 ——
    //    只认「这个选区落在什么性质的控件里」，不认「它在第几层路由」。
    //
    // 三档判定（从选区锚点向上走，命中即定档）：
    //   'chat'    —— 正文，可传
    //   'neutral' —— 语义上「不是正文」，绝不弹（输入框/代码块/按钮/菜单/侧栏/表格…）
    //   'unknown' —— 认不出来。保守处理：**也当作 neutral**（不弹）。
    //                宁可少弹一次让用户手动按快捷键，也不要在界面上乱糊气泡。
    //
    // 每条规则都写成 (selector, 理由) ，命中后理由会进诊断日志，
    // 现场想调时能一眼看出是「哪一类」把它拦下来了。

    /**
     * 语义排除表。命中任意一条 → neutral。
     * 全部只用**语义稳定**的选择器（标签名 / role / 原生控件类型），
     * 绝不引用 DSH 自己的 class 名 —— 那些会随版本漂移。
     */
    const NEUTRAL_RULES = [
      // 一切可编辑控件：输入框、搜索框、textarea、select、下拉…
      // （DSH 的 Lexical 输入框是 contenteditable，必须一起排掉）
      ['input, textarea, select, option, optgroup', 'form-control'],
      ['[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]', 'editable'],
      ['[role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"]', 'aria-input'],

      // 代码 / 标记类内容：传过去基本没意义，而且用户划代码通常是想复制
      ['code, pre, kbd, samp, var, [class*="language-"]', 'code'],
      ['[role="code"], .cm-editor, .monaco-editor, [class*="code-block"]', 'code-widget'],

      // 交互控件：划按钮/链接上的字几乎总是「复制按钮文案」，不是传送意图
      ['button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"]', 'control'],
      ['label, legend, summary, [role="checkbox"], [role="radio"], [role="switch"]', 'form-label'],
      ['[role="slider"], [role="spinbutton"], [role="progressbar"], meter', 'widget'],

      // 菜单 / 弹窗 / 浮层：点菜单时误冒气泡最烦人
      ['[role="menu"], [role="menubar"], [role="dialog"], [role="alertdialog"], [role="tooltip"]', 'overlay'],
      ['[role="tablist"], [role="toolbar"], [role="navigation"], [role="banner"], [role="contentinfo"]', 'nav'],
      ['nav, aside, header, footer, dialog, details, summary', 'landmark'],

      // 侧栏（会话列表 / 导航）：这里划词是「选会话名」，不是选内容
      ['[class*="sidebar"], [class*="Sidebar"], [class*="sidenav"], [class*="nav-list"]', 'sidebar'],

      // 表格 / 数据网格：插件市场、设置页、扩展列表大量用表格排版
      ['table, thead, tbody, tfoot, tr, td, th, [role="table"], [role="grid"], [role="row"], [role="cell"]', 'table'],
      ['dl, dt, dd', 'description-list'],

      // 筛选标签 / 徽章 / 芯片组：用户明确投诉过「在过滤标签处划词气泡弹出来挡界面」。
      // ⚠️ 这一组是本表里**唯一**带 class 关键词的规则（其余全靠语义标签）。
      //    原因：chip/tag/filter 这类控件在 ARIA 里没有对应 role，只有 <span>/<div>，
      //    纯语义查不出来；而这几个词（tag/chip/badge/pill/filter）在各 UI 库里
      //    含义高度一致，误伤正文的概率极低 —— 正文里出现 "tag" 容器的场合极少。
      ['[class*="chip"], [class*="Chip"], [class*="badge"], [class*="Badge"],' +
       ' [class*="pill"], [class*="tag-list"], [class*="tagList"], [class*="tags"],' +
       ' [class*="filter-bar"], [class*="filterBar"], [class*="filter-list"],' +
       ' [class*="filter-group"], [class*="facet"]', 'filter-chip'],

      // 图片 / 媒体 / SVG：内部文本不算正文
      ['svg, canvas, video, img, picture, [role="img"]', 'media'],
    ]

    /**
     * 「像对话正文」的阳性信号。只在 bubbleScope='conversation' 时才要求命中。
     * 注意：命中任一即放行，**不要求全部命中** —— DSH 换版改一个类名不该让功能整体失灵。
     */
    const CONVERSATION_HINTS = [
      '[class*="message"]', '[class*="Message"]',
      '[class*="conversation"]', '[class*="Conversation"]',
      '[class*="chat"]', '[class*="Chat"]',
      '[class*="markdown"]', '[class*="Markdown"]',
      '[class*="prose"]', '[class*="assistant"]', '[class*="bubble"]',
      '[data-role="user"]', '[data-role="assistant"]', '[data-message-id]',
      '[data-testid*="message"]', '[data-testid*="conversation"]',
      'article', '[role="main"]', '[role="log"]',
    ]

    /** 缓存最近一次判定的结果形状，避免同一次 mouseup 里反复遍历 DOM。 */
    let lastZoneVerdict = null

    /**
     * 判定某个元素所处的语义区域。
     *
     * @param {Element|null} el 选区锚点元素（Shadow DOM 里也能用）。
     * @returns {{zone:'chat'|'neutral'|'unknown', why:string}} 判定结果。
     */
    function classifyZone(el) {
      // 无锚点：判不了 → unknown → 保守不弹
      if (!el || !el.closest) return { zone: 'unknown', why: 'no-anchor' }

      // 先看整条祖先链上有没有 neutral 规则命中（含 el 自身）
      try {
        for (const rule of NEUTRAL_RULES) {
          // 用 matches 而非 closest：closest 只能向上找元素自身，
          // 但我们要判断的是「选区所在的这个元素本身是不是中性区」，
          // 两者都要。所以先 matches 自己，再 closest 祖先。
          const hitSelf = el.matches && el.matches(rule[0])
          const hitParent = el.closest(rule[0])
          if (hitSelf || hitParent) return { zone: 'neutral', why: rule[1] }
        }
      } catch (err) {
        // 选择器语法万一有问题（不该发生），宁可判 neutral 也不要崩
        return { zone: 'neutral', why: 'rule-error' }
      }

      // scope 收得更紧时，额外要求命中「像对话正文」的阳性信号
      try {
        if (String(config.bubbleScope || '').toLowerCase() === 'conversation') {
          for (const sel of CONVERSATION_HINTS) {
            if ((el.matches && el.matches(sel)) || el.closest(sel)) {
              return { zone: 'chat', why: 'conversation-hint' }
            }
          }
          return { zone: 'neutral', why: 'no-conversation-hint' }
        }
      } catch (err) {
        return { zone: 'neutral', why: 'scope-error' }
      }

      return { zone: 'chat', why: 'default-allow' }
    }

    /**
     * 取选区锚点元素，并把 zone 判定结果一起带出来。
     * @param {Selection} sel window.getSelection() 的结果。
     * @returns {{el:Element|null, zone:{zone:string,why:string}}}。
     */
    function anchorAndZone(sel) {
      const node = sel && sel.anchorNode
      const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null
      const zone = classifyZone(el)
      lastZoneVerdict = zone
      return { el: el, zone: zone }
    }

    /**
     * 「此刻的选区位置」是否仍属于允许区域。
     *
     * v1.6.0 引入，专为守住缓存兜底那条路径（详见 tryShowBubble 里的注释）：
     * readSelection 返回 null 有两种截然不同的原因 ——
     *   ① 压根没有合格选区（在搜索框里划词）→ **必须不冒**；
     *   ② 选区被 React 重渲染塌缩、但内容是对的（在正文里划词）→ 应当放行缓存。
     * 光看 readSelection 的返回值分不出这两者，所以这里单独问一句「锚点在不在允许区」。
     *
     * ⚠️ 拿不到锚点时（选区完全消失）返回 true：那种情况几乎总是 ②
     *    （DSH 重渲染把 range 换掉了），而缓存本身在写入时已经过了闸门，
     *    且有 armWindow 时间窗兜底，放行是安全的。
     *
     * @returns {boolean} 允许走缓存兜底则 true。
     */
    function selectionZoneAllowed() {
      try {
        const sel = window.getSelection()
        if (!sel) return true
        const got = selTextWithComposed(sel)
        const node = sel.anchorNode
        const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null
        // 连选区文本都没有（彻底塌缩）→ 属于 ②，放行缓存
        if (!el || !got.text) return true
        const zone = classifyZone(el)
        lastZoneVerdict = zone
        if (zone.zone === 'chat') return true
        // 明确落在中性区（输入框/搜索框/代码块/菜单…）→ 属于 ①，绝不放行
        lastSelReject = 'zone:' + zone.why
        return false
      } catch (err) {
        // 判不了就放行：缓存写入时已过闸门 + 有时间窗，误冒概率远小于「该冒却不冒」
        return true
      }
    }

    /**
     * 读取当前选中的纯文本，并算出气泡该出现在哪；没有有效选区就返回 null。
     * 📋 每个拒绝分支都记进 lastSelReject（DshOverlay 上报 bubble-none 用）——
     *    2026-10-01 排查「传送没反应」时发现：气泡没出现和点了没反应在日志里
     *    长得一模一样，必须区分。
     * 🔒 v1.6.0 新增：**语义区域闸门**。落在输入框/代码块/按钮/菜单/侧栏/表格/
     *    侧边栏里，或压根认不出来 → 直接返回 null，气泡绝不冒出来。
     * @returns {{text:string,left:number,top:number}|null} 气泡数据。
     */
    function readSelection() {
      try {
        const sel = window.getSelection()
        if (!sel) {
          lastSelReject = 'no-selection-object'
          return null
        }
        const got = selTextWithComposed(sel)
        if (!got.text) {
          lastSelReject = sel.rangeCount === 0 ? 'no-ranges' : 'collapsed'
          return null
        }
        const text = safeCleanText(got.text)
        if (!text) {
          lastSelReject = 'empty-after-clean'
          return null
        }

        // ── v1.6.0 语义区域闸门：这一段是本次修复的主体 ──
        const { el, zone } = anchorAndZone(sel)
        // 先排掉自己的 UI（.dsw-*）。注意 classifyZone 判不出 own-ui，
        // 因为它不认自有 class —— 这里单独前置，因为它优先级最高。
        if (el && el.closest && el.closest('.dsw-menu,.dsw-bubble,.dsw-toast')) {
          lastSelReject = 'inside-own-ui'
          return null
        }
        if (zone.zone !== 'chat') {
          lastSelReject = 'zone:' + zone.why
          return null
        }

        let rect = null
        try {
          if (got.range) rect = got.range.getBoundingClientRect()
        } catch (err) {
          rect = null
        }
        if (!rect || (!rect.width && !rect.height)) {
          lastSelReject = 'no-rect'
          return null
        }

        const vw = window.innerWidth || 1024
        // 气泡以选区水平中心为锚点，并夹进视口，避免贴边被切
        const left = Math.max(60, Math.min(Math.round(rect.left + rect.width / 2), vw - 60))
        const top = Math.max(30, Math.round(rect.top - 4))
        lastSelReject = ''
        return { text: text, left: left, top: top }
      } catch (err) {
        lastSelReject = 'exception:' + String((err && err.message) || err).slice(0, 60)
        return null
      }
    }

    /**
     * 把「当前活着的选区」刷进 selCache（selectionchange 拖选过程中高频调用）。
     * 只在选区真实存在且文本非空、且**通过语义区域闸门**时才缓存。
     *
     * 🐞 v1.6.0：这里必须和 readSelection 用同一套闸门。原来只用
     *    `closest('textarea,input,[contenteditable]')` 粗判，导致在插件市场
     *    划词时**缓存照样被填上**，随后 mouseup 走缓存兜底分支就把气泡弹了出来
     *    —— 这是「气泡在搜索框/过滤标签处冒出来」的直接成因，光改 mouseup 不够。
     *
     * 锚点优先用选区 rect（与气泡常规位置一致）；拿不到 rect 就留给调用方用
     * 鼠标位兜底（left/top 记为 NaN）。
     */
    function cacheSelection() {
      try {
        const sel = window.getSelection()
        if (!sel) return
        const got = selTextWithComposed(sel)
        if (!got.text) return
        const text = safeCleanText(got.text)
        if (!text) return
        const { el, zone } = anchorAndZone(sel)
        // 与 readSelection 同款的两道闸门，缺一不可
        if (el && el.closest && el.closest('.dsw-menu,.dsw-bubble,.dsw-toast')) return
        if (zone.zone !== 'chat') return
        let left = NaN
        let top = NaN
        try {
          if (got.range) {
            const rect = got.range.getBoundingClientRect()
            if (rect && (rect.width || rect.height)) {
              const vw = window.innerWidth || 1024
              left = Math.max(60, Math.min(Math.round(rect.left + rect.width / 2), vw - 60))
              top = Math.max(30, Math.round(rect.top - 4))
            }
          }
        } catch (err) {
          /* rect 拿不到就用鼠标位兜底（NaN 标记） */
        }
        selCache = { text: text, left: left, top: top, at: Date.now() }
      } catch (err) {
        /* 缓存失败不影响正常流程 */
      }
    }

    /**
     * 把选中的文字（带前缀）发给宿主，由宿主注入网页端输入框。
     * 全链路诊断：a2b-click（点击）→ a2b-result（宿主应答，含 CDP 注入结果），
     * 任何异常都在最外层 catch 里 Toast 报错，绝不静默吞掉。
     * @param {string} text 选中的纯文本。
     * @returns {Promise<void>} 完成。
     */
    /**
     * 把选区文本发给 Chat 网页端输入框。
     * @param {string} text 选中的文本。
     * @param {string} [source] 触发来源（v1.4.0 埋点用）：'bubble' / 'hotkey'。
     *   旧日志写死「气泡点击」，快捷键发送也被记成气泡点击，排查时严重误导 —— 现已区分。
     */
    async function sendSelectionToChat(text, source) {
      // 二次清洗（幂等）：readSelection 已经洗过，这里兜住任何别的调用点
      const body = safeCleanText(text)
      if (!body) {
        showToast('没有选中可发送的文字。', true)
        reportStatus({ phase: 'a2b-empty-selection', rawChars: String(text || '').length })
        return false
      }
      const prefix = String(config.transferPrefix || '')
      const from = source || 'unknown'
      try {
        diag('a2b-click: 发起发送（' + from + '），选中 ' + body.length + ' 字')
        reportStatus({ phase: 'a2b-click', chars: body.length, clean: CLEAN_VERSION, source: from })
        showToast('正在发送到 DeepSeek Relay…')
        // 带超时：宿主卡死 / 路由不存在时 20 秒内必有明确结果，绝不悬空
        const r = await postJson(BASE + '/inject', { text: prefix + body }, 30000)
        diag('a2b-result: ' + JSON.stringify(r))
        reportStatus({
          phase: 'a2b-result',
          ok: Boolean(r && r.ok),
          reason: (r && r.reason) || '',
          detail: (r && r.detail) || '',
        })

        if (r && r.ok) {
          // v1.4.0：成功提示带内容预览 —— 让用户能把「这次传送」和输入框里的文本对上号
          const preview = body.length > 14 ? body.slice(0, 14) + '…' : body
          showToast(
            '已填入 DeepSeek Relay（' +
              (r.how || '') +
              '）：' +
              preview +
              ' ——可以改了再发。',
          )
        } else if (r && r.reason === 'no-window') {
          showToast(r.detail, true)
        } else if (r && r.reason === 'timeout') {
          showToast('发送超时：宿主 20 秒内没有响应，请检查 DSH 实例是否正常运行。', true)
        } else if (r && r.reason === 'network') {
          showToast(r.detail + '，请确认 DSH 实例已重启加载本插件。', true)
        } else if (r && r.copied) {
          showToast('自动填入失败（' + ((r && r.detail) || '未知原因') + '），内容已复制到剪贴板，请手动前往网页端粘贴。', true)
        } else {
          showToast('发送失败：' + ((r && r.detail) || '未知原因'), true)
        }
        return Boolean(r && r.ok)
      } catch (err) {
        // 最外层兜底：任何异常都必须让用户看见，绝不静默吞掉
        const msg = String((err && err.message) || err)
        diag('a2b-error: ' + msg)
        reportStatus({ phase: 'a2b-error', error: msg })
        showToast('发送失败：' + msg, true)
        return false
      }
    }

    // ─────────────── A→B 划词气泡（纯 DOM 版，2026-10-01 重写）───────────────
    //
    // 🐞 为什么放弃 React/插槽渲染气泡：app 0.20.0 后，气泡无论挂 React 合成
    //    onClick 还是节点上的原生 capture 监听，点击都到不了（bubble-click 从未
    //    触发、/inject 无调用）—— shell.overlay 插槽容器层在 DSH 0.20.0 下会吞
    //    指针事件。换法：气泡直接挂 document.body（页面根节点，不在任何 DSH
    //    容器里），纯原生 DOM + 原生事件，与 DSH 的 React 体系零交集 —— 和
    //    page-script.js 在网页端的气泡是同一套做法（那个一直很稳）。
    //    触发用 pointerup（比 click 更原始，合成 click 被吞也不影响），
    //    mousedown/pointerdown 只做 preventDefault（保选区）。

    /** 当前原生气泡元素（null = 没显示）。 */
    let nativeBubbleEl = null
    /** 当前气泡是否已发送过（每次冒新气泡重置，防连点连发）。 */
    let nativeBubbleSent = false
    /**
     * v1.6.0：气泡自动消失的定时器句柄。
     * 🐞 需求「不遮挡关键 UI」的最后一道兜底：即便某条异常路径让气泡活了下来，
     *    6 秒后也一定自己走，不给用户任何「界面被糊住」的机会。
     */
    let bubbleHideTimer = 0
    /**
     * 最近一次气泡发送的时刻（0 = 从未）。
     * 🐞 2026-10-01 下午修复「点了没反应、要连点好几下」的关键标记：
     *    发送后短时间内（900ms）一律不再自动冒新气泡 —— 详见 onUp 处注释。
     */
    let lastBubbleFireAt = 0
    /**
     * 选区持续缓存 —— 2026-10-01 傍晚修复「划词后气泡不冒（no-selection）」的核心。
     *
     * 🐞 现场复盘：DSH 0.20.0 的消息区是 React 密集重渲染界面，用户拖选完成的
     *    瞬间（甚至拖选途中）重渲染就会替换 DOM 节点，浏览器随即将选区整个
     *    塌缩 —— mouseup 立即读和 10ms 补读全都扑空（selection 不会自己回来）。
     *    对策：拖选过程中用 selectionchange 持续缓存「最新非空选区」的文本和
     *    视口锚点；mouseup 读不到实时选区时用这份缓存（2 秒内有效）。
     *    这正是 page-script.js 网页端气泡一直稳定的原因（lastSelection 同款思路）。
     *
     * ⚠️ v1.6.0：缓存现在**也过语义区域闸门**（见 cacheSelection）。
     *    原来缓存不判区域，是「插件市场里划词也冒泡」的另一条漏斗，已堵死。
     */
    let selCache = null // { text, left, top, at } | null

    /** 收起原生气泡（没有就什么都不做）。 */
    function hideNativeBubble() {
      try {
        if (bubbleHideTimer) {
          window.clearTimeout(bubbleHideTimer)
          bubbleHideTimer = 0
        }
        if (nativeBubbleEl && nativeBubbleEl.parentNode) {
          nativeBubbleEl.parentNode.removeChild(nativeBubbleEl)
        }
      } catch (err) {
        /* 忽略 */
      }
      nativeBubbleEl = null
    }

    /**
     * v1.5.0 自动化自测把手：暴露气泡状态与触发口，CDP/Playwright 自测脚本
     * 用它验证「光环命中 / 附近按下不销毁 / 发送链路」三段逻辑（不影响正常使用）。
     */
    try {
      window.__dswBubble = {
        show: function (text, x, y) {
          showNativeBubble(String(text || '自测文本'), Number(x) || 200, Number(y) || 200)
        },
        hide: hideNativeBubble,
        state: function () {
          const el = nativeBubbleEl
          if (!el) return { shown: false }
          const r = el.getBoundingClientRect()
          return {
            shown: true,
            sent: nativeBubbleSent,
            text: el.textContent,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            hitFromPoint: (function () {
              try {
                const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                return top === el || el.contains(top)
              } catch (err) {
                return 'err'
              }
            })(),
          }
        },
      }
    } catch (err) {
      /* 忽略 */
    }

    /**
     * 在选区上方冒出纯 DOM 气泡「🐋 传给Chat」，点击即发送。
     * @param {string} text 选中的文本。
     * @param {number} left 气泡锚点 x（视口坐标）。
     * @param {number} top 气泡锚点 y。
     */
    function showNativeBubble(text, left, top) {
      try {
        hideNativeBubble()
        try {
          ensureStyle()
        } catch (err) {
          /* 样式已有就无所谓 */
        }
        const btn = document.createElement('button')
        btn.className = 'dsw-bubble'
        btn.type = 'button'
        btn.title = '把选中的文字发到 DeepSeek Relay 的输入框'
        btn.textContent = '🐋 传给Chat'
        btn.style.left = left + 'px'
        btn.style.top = top + 'px'
        /** 统一的发送动作（防重 + 埋点 + 收起）。 */
        const fire = (via) => {
          if (nativeBubbleSent) {
            // v1.4.0 埋点：点击真实到达了气泡、但被防重守卫挡住 —— 与「点击根本没
            // 被识别」在日志里区分开（800ms 节流）。若用户看到大量 blocked 记录，
            // 说明点击其实一直成功，只是 perceived 上以为没反应。
            const now = Date.now()
            if (now - lastBlockedAt > 800) {
              lastBlockedAt = now
              try {
                diag('bubble-blocked: 点击到达气泡但被防重守卫挡住（' + via + '）')
                reportStatus({ phase: 'bubble-blocked', via: via })
              } catch (err) {
                /* 忽略 */
              }
            }
            return
          }
          nativeBubbleSent = true
          lastBubbleFireAt = Date.now()
          const t = String(text || '')
          // 🐞 2026-10-01 下午修复「点一下不行、要连点好几下」（事件竞态）：
          //    旧代码在 fire 里**同步**摘掉气泡 —— 同一手势的 mouseup 派发时
          //    气泡已不在 DOM，target 守卫失效，残留选区把气泡原样冒回来。
          //    现方案：发送期间气泡变成「正在发送…」留在 DOM（让同一手势的
          //    mouseup 仍被守卫忽略），发送后按**成败**分态（v1.3.0）：
          //      成功 → 「✓ 已发送」500ms 后消失（并作废选区缓存）；
          //      失败 → 「✗ 失败，点击重试」**留在原地**，解除禁用并重置防重
          //               标记 —— 用户直接再点同一个小气泡即可重试。
          //    （v1.3.0 前的缺陷：失败也走「✓ 已发送 → 消失 + 清缓存 + 抑制窗」，
          //    失败后紧跟着的点击全被吞掉，现场＝「点好几下都没反应、
          //    日志里只有一次 a2b-click」。）
          try {
            btn.disabled = true
            btn.textContent = '正在发送…'
          } catch (err) {
            /* 忽略 */
          }
          try {
            reportStatus({ phase: 'bubble-click', via: via, chars: t.length })
          } catch (err) {
            /* 忽略 */
          }
          sendSelectionToChat(t, 'bubble').then((ok) => {
            try {
              if (ok) {
                selCache = null // 已发送的内容不再参与缓存兜底
                btn.textContent = '✓ 已发送'
                const sent = btn
                // v1.5.0：成功态从 500ms 延长到 1500ms —— 注入+切窗需要时间，
                // 用户回来看一眼时气泡还在，能把「这次点击」和结果对上号
                window.setTimeout(() => {
                  try {
                    if (nativeBubbleEl === sent) hideNativeBubble()
                  } catch (err) {
                    /* 忽略 */
                  }
                }, 1500)
              } else {
                nativeBubbleSent = false
                btn.disabled = false
                btn.textContent = '✗ 失败，点击重试'
              }
            } catch (err) {
              /* 忽略 */
            }
          })
        }
        // 保选区：按下的默认行为（清选区/转移焦点）都拦掉
        const keep = (ev) => {
          try {
            ev.preventDefault()
            ev.stopPropagation()
          } catch (err) {
            /* 忽略 */
          }
        }
        btn.addEventListener('pointerdown', keep, true)
        btn.addEventListener('mousedown', keep, true)
        // 主触发：pointerup —— 最原始的指针事件，不依赖合成 click
        btn.addEventListener(
          'pointerup',
          (ev) => {
            keep(ev)
            fire('native-dom:pointerup')
          },
          true,
        )
        // 兜底：万一 pointerup 不来（极老内核），click 也接
        btn.addEventListener(
          'click',
          (ev) => {
            keep(ev)
            fire('native-dom:click')
          },
          true,
        )
        document.body.appendChild(btn)
        nativeBubbleEl = btn
        nativeBubbleSent = false
        // v1.6.0：自动消失兜底。气泡是「临时提示」而非常驻控件 ——
        // 用户没点它、又没干别的，6 秒后就该自己走干净，绝不长期压界面。
        // 注意只在「未发送」状态下挂定时器：发送中/失败待重试的两个态有自己的生命周期，
        // 被这里提前收掉反而会让用户以为没发出去。
        try {
          if (bubbleHideTimer) window.clearTimeout(bubbleHideTimer)
          const life = Number(config.bubbleAutoHideMs)
          if (Number.isFinite(life) && life > 0) {
            bubbleHideTimer = window.setTimeout(() => {
              try {
                if (nativeBubbleEl === btn && !nativeBubbleSent) hideNativeBubble()
              } catch (err) {
                /* 忽略 */
              }
            }, life)
          }
        } catch (err) {
          /* 定时器起不来不影响气泡本身 */
        }
        // v1.4.0 遮挡自检：气泡出现后 0.4s / 1.5s 各查一次「气泡中心点最顶层的元素
        // 是不是气泡自己」。DSH 0.20.0 壳层若有一层透明遮罩压在气泡上方，点击会
        // 全被遮罩吃掉（视觉对准了也点不中）—— 这个检查能把遮罩的身份（标签/
        // class/z-index）直接写进日志，不用再猜。
        const coverCheck = (delay) => {
          window.setTimeout(() => {
            try {
              if (nativeBubbleEl !== btn || !btn.parentNode) return
              const r = btn.getBoundingClientRect()
              const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              if (!el || el === btn || btn.contains(el)) return
              const cs = window.getComputedStyle(el)
              const who =
                String(el.tagName || '?').toLowerCase() +
                ' cls=' +
                (el.className && el.className.baseVal !== undefined
                  ? String(el.className.baseVal).slice(0, 50)
                  : String(el.className || '').slice(0, 50)) +
                ' z=' +
                cs.zIndex +
                ' pos=' +
                cs.position
              diag('bubble-covered: 气泡被遮挡，顶层元素是 ' + who)
              reportStatus({ phase: 'bubble-covered', by: who })
            } catch (err) {
              /* 忽略 */
            }
          }, delay)
        }
        coverCheck(400)
        coverCheck(1500)
      } catch (err) {
        diag('showNativeBubble 抛错: ' + String((err && err.message) || err))
        hideNativeBubble()
      }
    }

    /**
     * 根作用域的浮层：只画偶发提示（toast）。
     *
     * 为什么挂在 root（`shell.overlay`）而不是 session 作用域：
     * 提示要没开会话时也能弹。划词气泡已改为纯 DOM（见上），不再经过这里。
     */
    function DshOverlay() {
      ensureStyle()
      const [toast, setToast] = React.useState(null)

      React.useEffect(() => {
        // 挂载自检：写进诊断文件，这样「浮层到底渲染了没有」一读便知
        diag('划词浮层已渲染（root / shell.overlay，气泡走纯 DOM）')
        diag('气泡触发模式: ' + String(config.bubbleTrigger))
        diag('气泡修饰键: ' + String(config.bubbleModifier || 'alt') + '（v1.6.0）')
        diag('气泡准入范围: ' + String(config.bubbleScope || 'input-excluded') + '（v1.6.0）')
        diag('快捷键直发: ' + String(config.hotkeySend) + '（v1.4.0，空=禁用）')
        reportStatus({
          phase: 'overlay-rendered',
          bubble: 'native-dom',
          hotkey: String(config.hotkeySend),
          trigger: String(config.bubbleTrigger),
          modifier: String(config.bubbleModifier || 'alt'),
          scope: String(config.bubbleScope || 'input-excluded'),
        })
      }, [])

      React.useEffect(() => {
        const fn = (v) => setToast(v)
        toastSubs.add(fn)
        if (toastValue) setToast(toastValue)
        return () => {
          toastSubs.delete(fn)
        }
      }, [])

      // ── A→B：监听划词，松开鼠标后在选区上方冒气泡（纯 DOM 版）──
      React.useEffect(() => {
        /** 最近一次 mouseup 的鼠标视口坐标（selCache 无 rect 时做气泡锚点兜底）。 */
        let lastPointer = { x: 0, y: 0 }
        /** selectionchange 节流时间戳（拖选过程高频触发，80ms 一拍足够）。 */
        let lastSelChangeAt = 0
        /** 最近一次「有效划词」的时刻（v1.6.0：modifier 模式的待命窗口起点）。 */
        let lastValidSelectAt = 0
        /** v1.6.0：当前触发模式的规范化结果（'modifier'|'contextmenu'|'select'|'off'）。 */
        const triggerMode = String(config.bubbleTrigger || 'modifier')
          .trim()
          .toLowerCase()
        /** v1.6.0：modifier 模式下用哪个修饰键。取不到就退 alt。 */
        const modKey = (function () {
          const m = String(config.bubbleModifier || 'alt').trim().toLowerCase()
          return m === 'ctrl' || m === 'control' || m === 'shift' || m === 'meta' || m === 'cmd'
            ? m === 'control'
              ? 'ctrl'
              : m === 'cmd'
                ? 'meta'
                : m
            : 'alt'
        })()
        /** modifier 模式的待命窗口（毫秒）。 */
        const armWindow = (function () {
          const n = Number(config.bubbleArmWindow)
          return Number.isFinite(n) && n >= 500 ? n : 4000
        })()
        /**
         * v1.6.0：统一的气泡弹出入口 —— 三种触发方式（modifier / contextmenu / select）
         * 全部走这一个函数，保证「三层读取 + 区域闸门 + 锚点计算」只有一份实现，
         * 以后调行为只需要动这里，不会出现三条路径各修各的情况。
         *
         * @param {string} via 触发来源，埋点用。
         * @param {{x:number,y:number}} point 气泡锚点（视口坐标）。
         * @returns {boolean} 是否真的冒出了气泡。
         */
        function tryShowBubble(via, point) {
          try {
            if (lastBubbleFireAt && Date.now() - lastBubbleFireAt < 900) return false
            const vw0 = window.innerWidth || 1024
            const ax = Math.max(70, Math.min(Math.round(point.x), vw0 - 70))
            const ay = Math.max(34, Math.round(point.y) - 10)

            // 三层读取保险（2026-10-01 重写，对症「划词后气泡不冒 no-selection」）：
            //  ① 立即读 —— 抢在 React 重渲染把选区弄没之前（多数场景这一下就成）
            //  ② 等一拍再读 —— mouseup 这一拍选区可能还没定稿（网页端稳定版的做法）
            //  ③ selectionchange 缓存 —— DSH 0.20.0 重渲染会在拖选完成瞬间替换节点、
            //     把选区整个塌缩（实测补读也救不回来），拖选过程中已持续记进 selCache。
            // ⚠️ 三层现在**全都过语义区域闸门**（v1.6.0）：区域不合格时三层一起拒绝，
            //    这是「插件市场/搜索框里绝不冒泡」得以成立的保证 ——
            //    缓存兜底那一层尤其关键，它当年就是绕过闸门的漏斗。
            const immediate = readSelection()
            if (immediate) {
              lastValidSelectAt = Date.now()
              showNativeBubble(immediate.text, ax, ay)
              try {
                reportStatus({ phase: 'bubble-show', via: via, chars: immediate.text.length })
              } catch (err) {
                /* 忽略 */
              }
              return true
            }
            window.setTimeout(() => {
              try {
                let text = ''
                const b = readSelection()
                if (b) {
                  text = b.text
                } else if (
                  selCache &&
                  Date.now() - selCache.at < armWindow &&
                  // 🐞 v1.6.0 关键补丁：**缓存兜底必须再确认当前选区仍在允许区域**。
                  //    否则会出现这样一条真实的漏斗（正是用户截图里「在插件市场搜索框
                  //    划词气泡弹出来挡界面」的成因）：
                  //      ① 在对话正文划词 → selCache 记下这段文字（当时合规）；
                  //      ② 走到插件市场，在搜索框里划词 → readSelection 被区域闸门拒绝；
                  //      ③ 但 4 秒内的 selCache 还热着 → 缓存兜底把它掏出来冒泡，
                  //         而且冒在**搜索框旁边**。
                  //    readSelection 之所以返回 null 有两种原因：「压根没有合格选区」
                  //    （该拦）和「选区被 React 重渲染塌缩、但缓存里是对的」（该放）。
                  //    用下面的 zone 复查把这两者区分开：前者区域不合格 → 不冒；
                  //    后者区域仍合格 → 放行缓存。既守住闸门，又不破坏 v1.2.0 的稳定性修复。
                  selectionZoneAllowed()
                ) {
                  text = selCache.text
                  try {
                    reportStatus({ phase: 'bubble-from-cache', chars: text.length })
                  } catch (err) {
                    /* 忽略 */
                  }
                }
                if (text) {
                  lastValidSelectAt = Date.now()
                  showNativeBubble(text, ax, ay)
                  try {
                    reportStatus({ phase: 'bubble-show', via: via, chars: text.length })
                  } catch (err) {
                    /* 忽略 */
                  }
                  return
                }
                // 划了词但气泡没冒出来：把原因上报（3 秒节流防刷屏）。
                // ⚠️ v1.6.0：排除区命中属于**预期行为**（不是故障），
                //    但仍要上报 —— 现场要靠这个确认「是哪一类区域把它拦下来了」，
                //    分类器的规则就是照着这些 why 值调的。
                const now = Date.now()
                if (now - lastBubbleNoneAt > 3000) {
                  lastBubbleNoneAt = now
                  const why = lastSelReject || 'unknown'
                  try {
                    reportStatus({ phase: 'bubble-none', why: why, via: via })
                  } catch (err) {
                    /* 忽略 */
                  }
                  if (String(why).indexOf('zone:') === 0) {
                    diag('bubble-none(zone): ' + via + ' 在「' + why.slice(5) + '」区域不冒泡（预期行为）')
                  }
                }
                hideNativeBubble()
              } catch (err) {
                /* 兜底：补读分支绝不让异常冒到事件循环 */
              }
            }, 0)
            return true
          } catch (err) {
            return false
          }
        }

        /**
         * v1.6.0：把修饰键状态存一份，供 onUp / onKey 判断。
         * 为什么不用 ev.modifierKey：DSH 0.20.0 的壳层会吞掉部分事件字段，
         * 自己跟踪 keydown/keyup 更可靠（v1.4.0 快捷键已经验证过这条路可行）。
         */
        const modState = { alt: false, ctrl: false, shift: false, meta: false }
        function syncModState(ev) {
          try {
            if (!ev) return
            // 只认「不带主键的纯修饰键按下/抬起」，避免 Ctrl+Shift+S 这类组合键
            // 在中途把 alt/ctrl 状态误清掉。
            const key = String(ev.key || '')
            if (key === 'Alt') modState.alt = true
            else if (key === 'Control') modState.ctrl = true
            else if (key === 'Shift') modState.shift = true
            else if (key === 'Meta') modState.meta = true
            // keyup / blur 一律按 ev 里的实际状态校准（按住不放时 ev.altKey 一直是 true，
            // 抬起才是 false —— 比自己记时间戳可靠）。
            if (ev.type === 'keyup' || ev.type === 'blur') {
              modState.alt = Boolean(ev.altKey)
              modState.ctrl = Boolean(ev.ctrlKey)
              modState.shift = Boolean(ev.shiftKey)
              modState.meta = Boolean(ev.metaKey)
            }
          } catch (err) {
            /* 忽略 */
          }
        }
        /** 当前配置的修饰键是否处于「按住」状态（同时看事件字段与跟踪状态）。 */
        function modActive(ev) {
          try {
            if (ev) {
              if (modKey === 'alt' && ev.altKey) return true
              if (modKey === 'ctrl' && ev.ctrlKey) return true
              if (modKey === 'shift' && ev.shiftKey) return true
              if (modKey === 'meta' && ev.metaKey) return true
            }
            return Boolean(modState[modKey])
          } catch (err) {
            return false
          }
        }

        function onUp(ev) {
          // 🐞 2026-10-01 下午补的抑制窗：气泡刚发送后的 900ms 内一律不再冒新气泡。
          //    仅靠下面的 target 守卫不够 —— 发送后气泡若已被摘掉（或被换成
          //    「✓ 已发送」态），mouseup 的 target 一旦不是气泡节点，守卫认不出，
          //    readSelection 就会靠「还活着的选区」把气泡重新冒出来，
          //    看起来正像「点击没生效」，用户于是连点好几下（每次都真发出去了）。
          if (lastBubbleFireAt && Date.now() - lastBubbleFireAt < 900) return
          // 点在气泡上的 mouseup 一律忽略 —— pointerup 马上要发送并收起气泡了；
          // 这里若再去 readSelection，会靠「还没消失的选区」把气泡设回来，
          // 用户以为没点上就连点（10-01 09:34 实测一秒三连发）。
          const t = ev && ev.target
          if (t && t.closest && t.closest('.dsw-bubble')) return
          lastPointer = { x: (ev && ev.clientX) || 0, y: (ev && ev.clientY) || 0 }
          syncModState(ev)

          // v1.6.0：触发模式分发。
          //  · 'off'        —— 气泡彻底关闭（快捷键仍可用）
          //  · 'modifier'   —— **新默认**。两条入口：
          //      ① 按住修饰键划词 → mouseup 时 modActive 为真 → 直接冒泡
          //      ② 先划词、后按修饰键 → 由 onKey 里的「待命窗口」分支冒泡
          //      两条都不满足 → **什么都不做**（用户日常划词不再被打扰，这是本次的核心）
          //  · 'contextmenu'—— 划词不冒，对选区右键才冒（见 onContextMenu）
          //  · 'select'     —— 旧行为：划词松手就冒（仍受区域闸门约束）
          if (triggerMode === 'off') return
          if (triggerMode === 'contextmenu') {
            // 划词只更新选区缓存（selectionchange 负责），不冒气泡
            return
          }
          if (triggerMode === 'modifier') {
            if (!modActive(ev)) {
              // 没按修饰键 —— 这次划词只是普通划词（复制/搜索/查看），**刻意不打扰**。
              // 但要记下「刚刚有效划过词」，这样用户紧接着按 Alt 也能唤出气泡（入口②）。
              const probe = readSelection()
              if (probe) lastValidSelectAt = Date.now()
              return
            }
            tryShowBubble('modifier:drag', lastPointer)
            return
          }
          // triggerMode === 'select'（兼容旧配置）
          tryShowBubble('select', lastPointer)
        }
        function onDown(ev) {
          // 点气泡本身时不要收起它（否则点不到）
          const t = ev.target
          if (t && t.closest && t.closest('.dsw-bubble')) return
          // v1.6.0：任何新的按下都是「新手势」—— modifier 模式的待命窗口一并作废。
          // 否则会出现「划词 → 点别处（气泡已收）→ 按 Alt 又冒出来」的隔空唤出。
          lastValidSelectAt = 0
          // v1.4.0 埋点：气泡活着、但这次的按下落在外面 —— 量一下落点离气泡中心
          // 多远。若日志显示大量 miss 且距离很小，说明气泡视觉位置与实际可点区域
          // 有偏移（translate 锚点/夹视口导致）；距离大则是用户点到了别处。
          if (nativeBubbleEl) {
            try {
              const r = nativeBubbleEl.getBoundingClientRect()
              const dx = Math.round(((ev && ev.clientX) || 0) - (r.left + r.width / 2))
              const dy = Math.round(((ev && ev.clientY) || 0) - (r.top + r.height / 2))
              const now = Date.now()
              if (now - lastMissReportAt > 800) {
                lastMissReportAt = now
                diag(
                  'bubble-miss: 气泡存活但点击落在外面（dx=' + dx + ' dy=' + dy +
                  ' target=' + ((t && (t.tagName || t.nodeName)) || '?') +
                  ' cls=' + ((t && t.className && String(t.className).slice(0, 40)) || '-'),
                )
                reportStatus({ phase: 'bubble-miss', dx: dx, dy: dy })
              }
            } catch (err) {
              /* 忽略 */
            }
          }
          hideNativeBubble()
          // 新手势开始：选区缓存一并作废 —— 防「点空白处清选区，mouseup 反而
          // 靠旧缓存把气泡又冒出来」；真在拖词的话 selectionchange 会重新填上。
          selCache = null
        }
        /**
         * 解析 v1.4.0 快捷键配置（形如 'ctrl+shift+s'）并与按键事件比对。
         * 修饰键要求精确匹配（多按少按都不算），主键按 ev.key 小写比对。
         */
        function hotkeyMatch(ev) {
          const spec = String((config && config.hotkeySend) || '')
            .toLowerCase()
            .trim()
          if (!spec) return false
          let wantKey = ''
          let wantCtrl = false
          let wantShift = false
          let wantAlt = false
          let wantMeta = false
          for (const p of spec.split('+')) {
            const part = p.trim()
            if (!part) continue
            if (part === 'ctrl' || part === 'control') wantCtrl = true
            else if (part === 'shift') wantShift = true
            else if (part === 'alt') wantAlt = true
            else if (part === 'meta' || part === 'cmd' || part === 'win') wantMeta = true
            else wantKey = part
          }
          if (!wantKey) return false
          if (String(ev.key || '').toLowerCase() !== wantKey) return false
          if (!!ev.ctrlKey !== wantCtrl) return false
          if (!!ev.shiftKey !== wantShift) return false
          if (!!ev.altKey !== wantAlt) return false
          if (!!ev.metaKey !== wantMeta) return false
          return true
        }
        /**
         * v1.4.0 快捷键直发：物理绕开「点气泡」整条指针链路。
         * 输入框里不抢键；取文本走与气泡相同的三层逻辑（实时 → armWindow 缓存）。
         * ⚠️ v1.6.0：快捷键**不再自己查缓存兜底** —— 它是「显式意图」动作，
         *    缓存兜底是为气泡冒泡服务的（React 重渲染塌缩场景）。快捷键只认真实选区，
         *    避免用户早就划好的词被一个误按的组合键发出去。
         */
        function onHotKey(ev) {
          const t = ev && ev.target
          if (t && t.closest && t.closest('textarea,input,[contenteditable="true"]')) return
          let text = ''
          const live = readSelection()
          if (live) text = live.text
          if (!text) {
            try {
              diag('hotkey-none: 快捷键触发但选区为空（' + (lastSelReject || 'unknown') + '）')
              reportStatus({ phase: 'hotkey-none', why: lastSelReject || 'unknown' })
            } catch (err) {
              /* 忽略 */
            }
            return
          }
          try {
            ev.preventDefault()
          } catch (err) {
            /* 忽略 */
          }
          try {
            diag('hotkey-send: 快捷键直发，选中 ' + text.length + ' 字')
            reportStatus({ phase: 'hotkey-send', chars: text.length })
          } catch (err) {
            /* 忽略 */
          }
          // 与气泡共享 900ms 发送抑制窗：快捷键发完的瞬间，mouseup 别再把气泡冒回来
          lastBubbleFireAt = Date.now()
          hideNativeBubble()
          const preview = text.length > 14 ? text.slice(0, 14) + '…' : text
          sendSelectionToChat(text, 'hotkey').then((ok) => {
            try {
              if (ok) {
                selCache = null
                showToast('✓ 已传给 Chat：' + preview, false)
              } else {
                showToast('✗ 传送失败，请重试快捷键', true)
              }
            } catch (err) {
              /* 忽略 */
            }
          })
        }
        /**
         * v1.6.0：modifier 模式的入口② —— 「先划词、再按修饰键」。
         *
         * 为什么必须有这条：Windows 上按住 Alt 再拖选划词时，Alt 可能被 DSH 壳层
         * 或系统菜单栏吃掉，导致入口①（按住 Alt 划词）时灵时不灵。
         * 让用户可以「正常划完词，再补按一下 Alt」，两条入口互为冗余，
         * 任意一条可用就够了 —— 交互的可靠性比姿势的优雅重要。
         *
         * 触发条件全部满足才冒泡（缺一不可）：
         *   ① 模式是 modifier；
         *   ② 按下的是配置的修饰键**本身**（不能带主键，否则会误吞 Ctrl+Shift+S 这类快捷键）；
         *   ③ 刚划过有效选区（armWindow 毫秒内）—— 防止「很久以前划过一次，
         *      现在随手按 Alt」这种隔空唤出；
         *   ④ 此刻读得到合格选区（区域闸门 + 三层读取，失败就不冒）。
         */
        function onArmKey(ev) {
          try {
            if (triggerMode !== 'modifier') return
            const key = String(ev.key || '')
            const isModKey =
              (modKey === 'alt' && key === 'Alt') ||
              (modKey === 'ctrl' && key === 'Control') ||
              (modKey === 'shift' && key === 'Shift') ||
              (modKey === 'meta' && key === 'Meta')
            // ⚠️ 只认修饰键**本身**的 keydown。这里绝不能按「key 长度」判断是不是主键
            //    —— 'Alt'/'Shift'/'Control' 的长度都 > 1，用长度过滤会把修饰键自己
            //    也滤掉，整条入口② 永远不会触发（这是实测踩到的坑）。
            //    带主键的情况由 onKey 里的 hotkeyMatch 先判掉，这里天然收窄。
            if (!isModKey) return
            if (ev.ctrlKey && modKey !== 'ctrl') return
            if (ev.metaKey && modKey !== 'meta') return
            // 待命窗口外 → 只当普通修饰键，不做任何事（也就不会有副作用）
            if (!lastValidSelectAt || Date.now() - lastValidSelectAt > armWindow) return
            // 此刻读不到合格选区就不冒（区域闸门在此生效：输入框里划的词按 Alt 也不会冒）
            const live = readSelection()
            if (!live) return
            lastValidSelectAt = 0 // 消费掉，避免同一次划词连按两次 Alt 冒两个泡
            tryShowBubble('modifier:key', lastPointer)
          } catch (err) {
            /* 绝不让这条便捷路径影响正常输入 */
          }
        }
        function onKey(ev) {
          if (ev.key === 'Escape') {
            hideNativeBubble()
            lastValidSelectAt = 0
            return
          }
          if (hotkeyMatch(ev)) {
            onHotKey(ev)
            return
          }
          // 快捷键之后不再走 arm 分支：Ctrl+Shift+S 里 Shift 也是 modKey，
          // 顺序上先判 hotkey 就不会重复响应。
          onArmKey(ev)
          syncModState(ev)
        }
        function onSelChange() {
          const now = Date.now()
          if (now - lastSelChangeAt < 80) return
          lastSelChangeAt = now
          cacheSelection()
        }
        function onContextMenu(ev) {
          // v1.2.0：仅 contextmenu 模式生效。对**有文字的选区**右键时，
          // 在光标上方冒出传送气泡（DSH 自带的右键菜单照常弹出，两者并存：
          // 气泡悬在光标上方，菜单在光标处，左键点气泡即发送）。
          // v1.6.0：mode 为 'modifier' 时**右键同样可用** —— 右键本来就是
          // 明确的「我要对这个选区做点什么」信号，不需要额外手势，
          // 所以给 modifier 模式开这个口子能显著提升可用性。
          const t = ev && ev.target
          if (t && t.closest && t.closest('.dsw-bubble')) return
          if (triggerMode !== 'contextmenu' && triggerMode !== 'modifier') return
          if (lastBubbleFireAt && Date.now() - lastBubbleFireAt < 900) return
          // 读选区：优先实时，其次 armWindow 内的 selCache（React 重渲染清选区场景的兜底）
          let text = ''
          const live = readSelection()
          if (live) text = live.text
          else if (selCache && Date.now() - selCache.at < armWindow) text = selCache.text
          if (!text) return
          lastPointer = { x: (ev && ev.clientX) || 0, y: (ev && ev.clientY) || 0 }
          const vw = window.innerWidth || 1024
          // 气泡 CSS 是 translate(-50%,-100%)：锚点给光标坐标，气泡自然落在光标上方
          const left = Math.max(60, Math.min(Math.round(lastPointer.x), vw - 60))
          const top = Math.max(30, Math.round(lastPointer.y) - 6)
          try {
            reportStatus({ phase: 'bubble-contextmenu', chars: text.length })
          } catch (err) {
            /* 忽略 */
          }
          showNativeBubble(text, left, top)
        }
        /**
         * v1.6.0：滚动 / 失焦 / 缩放 → 收起气泡。
         *
         * 🐞 这条以前是**缺失**的（page-script.js 那边有，client.js 漏了）：
         *    气泡是 fixed 定位，页面一滚它就停在原地不动 —— 原来贴着选区，
         *    滚完之后变成一块悬在半空的药丸，正好压在输入框或中间某个控件上。
         *    这就是「气泡挡住界面」的另一半成因，光加区域闸门解决不了。
         * capture=true 才能收到内层滚动容器的 scroll（冒泡阶段收不到）。
         */
        function onHide() {
          try {
            hideNativeBubble()
            // 滚动意味着选区可能已经移开/移走，待命窗口一并作废，
            // 免得滚完之后按 Alt 唤出一个位置对不上的气泡。
            lastValidSelectAt = 0
          } catch (err) {
            /* 忽略 */
          }
        }
        document.addEventListener('mouseup', onUp, true)
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('keyup', syncModState, true)
        document.addEventListener('selectionchange', onSelChange, true)
        document.addEventListener('contextmenu', onContextMenu, true)
        // v1.6.0 新增：滚动 / 窗口失焦 / 缩放都收起气泡。
        // 冒泡 + 页面滚动都要管，所以 capture=true；页面级 scroll 也单独挂 window。
        window.addEventListener('scroll', onHide, true)
        window.addEventListener('resize', onHide, true)
        window.addEventListener('blur', onHide, true)
        return () => {
          document.removeEventListener('mouseup', onUp, true)
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('keyup', syncModState, true)
          document.removeEventListener('selectionchange', onSelChange, true)
          document.removeEventListener('contextmenu', onContextMenu, true)
          window.removeEventListener('scroll', onHide, true)
          window.removeEventListener('resize', onHide, true)
          window.removeEventListener('blur', onHide, true)
          hideNativeBubble()
        }
      }, [])

      const toastEl = toast
        ? React.createElement(
            'div',
            { className: 'dsw-toast', 'data-err': toast.isError ? '1' : '0' },
            toast.text,
          )
        : null

      // 永远渲染一个不可见的标记节点：这样「浮层到底挂上了没有」可以直接从 DOM 查出来，
      // 不用靠猜。（shell.overlay 本身是 click-through 的，这个 display:none 的节点
      // 也不会接收任何指针事件。）
      const marker = React.createElement('span', {
        'data-dsh-overlay': '1',
        style: { display: 'none' },
      })
      return React.createElement(React.Fragment, null, marker, toastEl)
    }

    /**
     * session 作用域的接力桥：**只做一件事** —— 抓住 DSH 给的 inputActions
     * （里面有 setDraft），供 B→A 接力把内容写进输入框。自己不渲染任何东西。
     *
     * 之所以要单独挂在 session 作用域：输入动作面只有 session 作用域组件才拿得到。
     * 界面部分（气泡、提示）已经挪到 root 的 DshOverlay 里了，没会话也能用。
     */
    function RelayBridge(props) {
      // 抓输入动作面 + 提取会话身份指纹。渲染期赋值是幂等的，可以接受。
      // ⚠️ 绝不在这里清空 / 拒绝回填：新会话可能在「点击派发」的同一个同步流程里
      //    就完成挂载并触发本组件渲染 —— 此刻必须把最新的动作面接住并尝试即写
      //    （旧会话的识别靠多信号确认 detectNewSession，不靠清空）。
      // ⚠️ hasActions 必须声明在 try 外面：后面 useEffect 的闭包要引用它 ——
      //    声明在 try 块里会因块级作用域拿不到（上一版就栽在这个 ReferenceError
      //    上：useEffect 整个没注册，挂载计数/卸载清理全部静默失效）。
      let hasActions = false
      try {
        hasActions =
          !!(props && props.inputActions && typeof props.inputActions.setDraft === 'function')
        if (hasActions) {
          if (!sessionInput) diag('已取得 inputActions（setDraft 可用）')
          sessionInput = props.inputActions
        }
        // 会话身份指纹：props 里任何像 session id 的字段（含嵌套一层）。
        // DSH 切换会话时它必然变化 —— 比 DOM 节点身份可靠得多。
        const identity = extractSessionIdentity(props)
        if (identity && identity !== lastSessionIdentity) {
          diag('接力桥观测到会话身份：' + (lastSessionIdentity || '（无）') + ' → ' + identity)
          lastSessionIdentity = identity
        }
        // 🆕 分支即写：branchArmed 且有待写内容、且通过「新会话多信号确认」
        // （桥重挂载 / 会话身份变化 / 路由变化 / 输入框节点更换且旧节点已卸载 /
        //   动作面换实例且有旁证 / 侧边栏高亮项易位，任一成立）才立刻写入。
        // 幂等由 finishBranchWrite 保证（先取走内容再写，双路径谁先到谁写）。
        // 未经确认绝不写 —— 旧会话流式重渲染也可能换动作面实例（红线）。
        try {
          if (hasActions && branchArmed && !branchWritten && readPendingBranch()) {
            const ev = detectNewSession()
            if (ev.ok) {
              markBranchConfirmed('bridge:' + ev.signals.join('+'))
              // 即写凭证：动作面换了新实例，或本会话身份指纹变化 —— 二者任一才当场写。
              // 仅有 DOM 信号（输入框换节点/高亮易位）时只确认不写：那时动作面可能
              // 还是旧引用，盲写会落空（13:50 实测：actionsFresh 15 拍全 false）。
              // 写入交给轮询（fresh/remount/identity 三凭证）或直写兜底路径。
              const actionsChangedNow = Boolean(sessionInput && sessionInput !== branchPrevActions)
              const identityChangedNow = Boolean(
                lastSessionIdentity &&
                  branchPrevIdentity &&
                  lastSessionIdentity !== branchPrevIdentity,
              )
              if (actionsChangedNow || identityChangedNow) {
                diag('branch-bridge: 新会话桥已渲染（' + ev.signals.join(' + ') + '）→ 即写')
                reportStatus({ phase: 'branch-bridge-write', signals: ev.signals })
                finishBranchWrite('bridge')
              }
            }
          }
        } catch (err) {
          /* 即写失败不影响桥本身的职责 */
        }
        // 只报一次：把 DSH 实际传下来的 props 键名记进诊断文件。
        // 万一将来 DSH 改了这块契约，读一眼诊断就知道，不用去猜。
        if (!relayPropsLogged) {
          relayPropsLogged = true
          const keys = props ? Object.keys(props).sort() : []
          diag('接力桥已渲染；有 inputActions=' + hasActions + '；props 键=' + keys.join(','))
          reportStatus({ phase: 'relay-bridge-rendered', hasActions, propKeys: keys })
        }
      } catch (err) {
        /* 忽略 */
      }
      // 挂载/卸载计数（React 生命周期信号）：本组件挂在 conversation.session
      // 作用域，DSH 切换会话 = 该作用域重挂载 = 计数 +1 —— 这是「新会话页面
      // 已出现」最直接的信号，比 DOM 比对更早、更准；旧会话的流式重渲染
      // 不会重挂载本组件（key 不变），天然免疫误判。
      try {
        // 捕获本实例自己的动作面，供卸载清理时做身份对比（防误清新实例的）
        const myActions = hasActions ? props.inputActions : null
        React.useEffect(function () {
          branchMountCount++
          const myMount = branchMountCount
          diag('RelayBridge 挂载（第 ' + myMount + ' 次）')
          if (branchArmed && !branchWritten && myMount > branchPrevMount) {
            markBranchConfirmed('bridge-remount')
            diag('branch-bridge: 作用域重挂载（#' + branchPrevMount + ' → #' + myMount + '）')
            reportStatus({ phase: 'branch-bridge-remount', from: branchPrevMount, to: myMount })
            // 新会话的动作面已在渲染期接住（上面的同步代码先于 effect 执行），直接即写
            if (readPendingBranch()) finishBranchWrite('bridge-remount')
          }
          return function () {
            diag('RelayBridge 卸载（第 ' + myMount + ' 次实例）')
            // 🐞 2026-09-30 关键修复：旧会话的桥卸载时，必须清掉它接住的动作面。
            //    否则「旧桥卸载 → 新桥尚未挂载」的窗口期里，sessionInput 仍是
            //    旧会话的残留引用 —— 轮询/重试路径会拿它 setDraft，内容写进虚空
            //    （这正是 branchSeq 16/17「写入成功但输入框永远空」的根因）。
            //    只清自己那份：新桥若已在渲染期接住新动作面，绝不动它。
            try {
              if (myActions && sessionInput === myActions) {
                sessionInput = null
                diag('旧桥卸载：已清掉旧会话的动作面引用（防残留写入）')
              }
            } catch (err) {
              /* 忽略 */
            }
          }
        }, [])
      } catch (err) {
        /* hooks 不可用时静默降级为纯渲染期探测 */
      }
      return null
    }

    /**
     * 读一眼输入框里已有的文字 —— 只用来决定「追加」还是「替换」。
     * 这是纯 DOM 读取，不写入，所以不会被 Lexical 的渲染冲掉。
     *
     * ⚠️ 卡顿修复：读 `innerText` 会**强制一次同步重排**，草稿越长越慢。
     * 所以先用 `textContent.length`（不算布局，几乎零成本）做上限判断：
     * 草稿已经很长时就不再读它，直接按「不追加」处理，避免每 1.5 秒轮询都重排一次。
     */
    /**
     * 我们**上一次写进输入框的完整草稿**。
     *
     * 🐞 2026-09-27 修复的「重复粘贴好几遍 / 草稿越读越短」：
     *   读输入框靠 `innerText`，但输入框有**渲染高度上限** —— 草稿很长时 `innerText`
     *   只会给出"渲染出来的那部分"（实测：写进去 5869 字，读回来只有 4821、4128、3468…），
     *   于是每次「读草稿 → 追加」都在拿一份被截短的草稿，缺的部分被丢掉、内容看起来重复错乱。
     *   修法：以这个镜像为准（我们自己写的，长度准确）。
     */
    let lastDraftWritten = ''

    /**
     * 接力写入模式。
     *
     * 🐞 2026-09-27 的教训：以前**总是追加**，而 DSH 输入框是 Lexical ——
     *    `setDraft` 会**清空并重建整棵内容树**，代价随草稿长度线性增长。
     *    几轮累积到几千字后，每次写入要几百毫秒到数秒，界面直接点不动。
     *
     * 所以默认改成 **'replace'（覆盖）**：输入框里永远只有**这一条**接力内容，
     * 写入规模恒定 → 不可能再撑爆、也不可能重复叠加。
     * 需要"攒上下文"的用户可显式配置 `relayAppendMode: 'append'`。
     *
     * @returns {'replace'|'append'} 当前模式。
     */
    function relayAppendMode() {
      try {
        const m = String(config.relayAppendMode || '').toLowerCase()
        return m === 'append' ? 'append' : 'replace'
      } catch (err) {
        return 'replace'
      }
    }

    /**
     * 计算最终要写进输入框的草稿（**纯函数**，不碰 DOM，便于验证）。
     *
     * @param {'replace'|'append'} mode 写入模式。
     * @param {string} existing 已有草稿（仅 append 模式使用）。
     * @param {string} block 本次要写入的内容块。
     * @param {number} cap 草稿总长上限（仅 append 模式使用）。
     * @returns {{text:string, trimmedOld:number}} 最终文本与被裁掉的字数。
     */
    function composeDraft(mode, existing, block, cap) {
      const b = String(block == null ? '' : block)
      if (mode !== 'append') return { text: b, trimmedOld: 0 }
      const ex = String(existing == null ? '' : existing)
      let text = ex ? ex.replace(/\s+$/, '') + '\n' + b : b
      let trimmedOld = 0
      const limit = Number(cap) > 0 ? Number(cap) : 0
      if (limit > 0 && text.length > limit) {
        const keepFrom = text.length - limit
        const cutAt = text.indexOf('\n', keepFrom)
        const tail = text.slice(cutAt >= 0 ? cutAt + 1 : keepFrom)
        trimmedOld = text.length - tail.length
        text = '……（较早的内容已自动裁剪，避免输入框被撑爆）' + '\n' + tail
      }
      return { text: text, trimmedOld: trimmedOld }
    }

    /**
     * 取"用于追加的已有草稿"。
     *
     * 优先用镜像（准确）；只有在**读回来的内容明显更接近真实**（例如用户自己编辑过、
     * 长度和镜像不一致但读回值更完整）时才采信 DOM。读回来比镜像短 → 说明被渲染截断，
     * 一律以镜像为准。
     *
     * @returns {string} 已有草稿（没有则返回 ''）。
     */
    function readDraftForAppend() {
      const mirror = String(lastDraftWritten || '')
      let fromDom = ''
      try {
        const eds = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(
          (el) => el.offsetParent !== null,
        )
        const el = eds[eds.length - 1]
        if (el) {
          // 读回来后必须归一：Lexical 把段落边界读成 \n，空行会读成两个 \n，
          // 不归一就会在每轮「读→写」中把空行翻倍累积。
          fromDom = normalizeDraftReadback(String(el.innerText || ''))
        }
      } catch (err) {
        fromDom = ''
      }
      // DOM 读回不完整（渲染截断）或空 → 用镜像
      if (!fromDom || fromDom.length < mirror.length) {
        if (mirror) diag('草稿以镜像为准（读回 ' + fromDom.length + ' 字 / 镜像 ' + mirror.length + ' 字）')
        return mirror
      }
      // 用户自己编辑过（读回更长或等长但不同）→ 采信 DOM，并更新镜像
      if (fromDom !== mirror) {
        diag('草稿以编辑器为准（读回 ' + fromDom.length + ' 字 / 镜像 ' + mirror.length + ' 字）')
        lastDraftWritten = fromDom
      }
      return fromDom
    }

    /**
     * 剥掉文本开头**所有已知的接力前缀行**（连同其后的空行）。
     *
     * 为什么需要"所有已知"而不是只比对当前配置那一条：两端默认文案历史上不一致
     * （宿主 / 网页端 / 客户端各写过一句），只比对一条时去重会失效，
     * 每次接力都会再贴一块「前缀 + 空行」—— 现场表现就是「大量空白」。
     *
     * @param {string} text 已清洗的文本。
     * @returns {string} 去掉开头前缀行的文本。
     */
    const KNOWN_RELAY_PREFIXES = [
      '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】',
      '【以下是来自 DeepSeek 网页端的上下文，请基于此继续帮我完成后续任务】',
      '【来自 DeepSeek 网页端上下文】',
    ]

    function stripRelayPrefixes(text) {
      try {
        // 词首空白先清掉，避免后续 startswith 判断被前导空格干扰
        let t = String(text == null ? '' : text).replace(/^[ \t]+/, '')
        // ① 已知文案的前缀：不管后面跟的是换行、空行还是直接接正文，一律切掉
        //    （v1.5 起网页端把前缀**直接贴在正文同一行**，所以不能只按"整行匹配"处理）
        for (let i = 0; i < 5; i++) {
          let matched = false
          for (const p of KNOWN_RELAY_PREFIXES) {
            if (t.startsWith(p)) {
              t = t.slice(p.length).replace(/^[ \t]*\n*/, '')
              matched = true
              break
            }
          }
          // ② 兜底：未知文案的短前缀整行（【…网页端…】）
          if (!matched) {
            const m = t.match(/^\s*([^\n]*)\n/)
            if (m) {
              const l = m[1].trim()
              if (l && l.length <= 60 && l.startsWith('【') && l.endsWith('】') && l.includes('网页端')) {
                t = t.slice(m[0].length).replace(/^[ \t]+/, '')
                matched = true
              }
            }
          }
          if (!matched) break
        }
        // ⚠️ 这里**不做**全文换行压缩：那会把多块草稿压平。空行归一交给
        //    normalizeDraftReadback()，只在「从编辑器读回草稿」时做。
        return t.trim()
      } catch (err) {
        return String(text == null ? '' : text)
      }
    }

    /**
     * 归一「从编辑器读回来的草稿」。
     *
     * 为什么需要：DSH 输入框是 Lexical，段落边界读回来是 `\n`，一个空行会读成两个 `\n`；
     * 不做归一，每轮「读草稿 → 写回」都会让空行翻倍累积（现场就是「大量空白」）。
     * 归一规则与 safeCleanText 一致：行尾空白去掉、3 个以上换行压成 2 个 —— 幂等。
     *
     * @param {string} text 从编辑器读回的草稿。
     * @returns {string} 归一后的草稿。
     */
    function normalizeDraftReadback(text) {
      try {
        return String(text == null ? '' : text)
          .replace(/\s+$/, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
      } catch (err) {
        return String(text == null ? '' : text)
      }
    }

    /**
     * 尽力把文本放进剪贴板（B→A 无会话 / 分支失败时的内容保全）：
     * navigator.clipboard 优先（无用户手势可能被拒）→ 隐藏 textarea + execCommand 兜底。
     * 只尽力、不保证，永不抛错。
     */
    async function copyTextBestEffort(text) {
      const t = String(text == null ? '' : text)
      if (!t) return false
      try {
        await navigator.clipboard.writeText(t)
        return true
      } catch (err) {
        /* 走下面的兜底 */
      }
      try {
        const ta = document.createElement('textarea')
        ta.value = t
        ta.setAttribute('readonly', '')
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        try {
          ta.setSelectionRange(0, t.length)
        } catch (err) {
          /* 忽略 */
        }
        const ok = document.execCommand('copy')
        ta.remove()
        return ok
      } catch (err) {
        return false
      }
    }

    /** 把一条接力内容写进 DSH 输入框，并把结果回执给网页端（失败时网页端会兜底复制）。 */
    function applyRelay(item) {
      const ackId = item && item.id ? String(item.id) : ''
      /** 回报结果给网页端。网页端气泡在等这个：失败/超时它会写剪贴板并弹窗。 */
      const ack = (ok, detail) => {
        if (!ackId) return
        try {
          postJson(BASE + '/relay-ack', { id: ackId, ok: ok === true, detail: detail || '' })
        } catch (err) {
          /* 回执失败不影响写入本身 */
        }
      }
      try {
        // ① 先把正文洗出来（后面无论走哪条路都要用它）
        const rawLen = item && typeof item.text === 'string' ? item.text.length : 0
        const body = safeCleanText(item.text)
        if (!body) {
          showToast('网页端这次没拿到选中的文字。', true)
          reportStatus({ phase: 'relay-empty', rawChars: rawLen })
          ack(false, '内容为空')
          return
        }

        // ② 严格检测「活跃会话」：不仅要有官方动作面（sessionInput.setDraft），
        //    还必须真的存在一个**可见的**输入框元素（getBoundingClientRect 口径）。
        //    只有动作面、没有可见输入框，说明当前没有打开的会话（动作面可能是
        //    上一次会话留下的残留引用）—— 绝不瞎写。
        //    ⚠️ 严禁只凭 querySelector('[contenteditable="true"]') 盲找盲写。
        const activeInput = findVisibleInputEl()
        if (!sessionInput || typeof sessionInput.setDraft !== 'function' || !activeInput) {
          showToast('当前没有打开的 DSH 会话，请先打开或新建一个', true)
          reportStatus({
            phase: 'relay-no-session',
            hasActions: Boolean(sessionInput),
            hasVisibleInput: Boolean(activeInput),
            chars: body.length,
          })
          ack(false, 'DSH 当前没有打开的会话')
          // 内容放剪贴板兜底，绝不写到任何别的地方
          copyTextBestEffort(body)
          return
        }

        // 网页端已经洗过一遍；这里再做一次幂等清洗的产物 body 已就绪。
        // safeCleanText 内部已硬截断到 TRANSFER_MAX_CHARS，所以 body 永远不会超长。
        const truncated = rawLen > body.length
        // 网页端（page-script）已经按 config.relayPrefix 加过前缀了；
        // 这里做个去重，免得旧版/直接调用时被加两次。
        //
        // 🐞 2026-09-27 修复的「大量空白」根因（两条一起）：
        //    ① 两端前缀文案曾不一致 → 去重永不成立 → 每接一次多贴「前缀 + 空行」；
        //    ② DSH 输入框是 Lexical，`setDraft` 把每个 `\n` 变成一个**段落**，
        //       空行 = 一个真空段落（带段间距），块间再插空行就会成片空白。
        //    统一契约：**每块恰好一个前缀**，由宿主保证（网页端加了就剥掉再加回，
        //    没加就补上）—— 这样无论对方是新版还是旧版，输入框里都不会缺、也不会重复。
        const relayPrefix = String(config.relayPrefix || '').trim()
        const stripped = stripRelayPrefixes(body)
        // 网页端若已把前缀贴在正文首行（新格式）→ 同段拼回；若是旧格式（前缀独占一行）
        // 或根本没加 → 用换行分隔，保持"前缀 + 正文"两段的结构。
        const hadInlinePrefix = relayPrefix ? body.trimStart().startsWith(relayPrefix) : false
        const block = stripped
          ? relayPrefix
            ? relayPrefix + (hadInlinePrefix ? '' : '\n') + stripped
            : stripped
          : body
        // 写入策略：默认 'replace'（覆盖）——见 composeDraft 的说明。
        const mode = relayAppendMode()
        const cap = Number(config.draftMaxChars) > 0 ? Number(config.draftMaxChars) : DSH_DRAFT_MAX
        const existing = mode === 'append' ? readDraftForAppend() : ''
        const result = composeDraft(mode, existing, block, cap)
        const next = result.text
        const trimmedOld = result.trimmedOld

        sessionInput.setDraft(next)
        // 记下这次写进去的完整内容：下一次（若为追加模式）以它为准，
        // 不再依赖会被渲染截断的 innerText。
        lastDraftWritten = next
        showToast(
          '已接力 ' + body.length + ' 字符到输入框' +
            (mode === 'replace' ? '（已覆盖原草稿）' : '') +
            (truncated ? '（原文 ' + rawLen + ' 字，已按 ' + TRANSFER_MAX_CHARS + ' 字上限截断）' : '') +
            (mode === 'append' && existing ? '（追加在你原有内容后面）' : '') +
            (trimmedOld ? '（输入框总长已限制在 ' + cap + ' 字，裁剪了较早的 ' + trimmedOld + ' 字）' : '') +
            '，可以直接改了再发。',
        )
        diag(
          '接力已写入输入框(' + mode + ')，本条 ' + body.length + ' 字符，草稿总长 ' + next.length + ' 字符' +
            (truncated ? '（原文 ' + rawLen + ' 字，已截断）' : '') +
            (trimmedOld ? '（裁剪较早内容 ' + trimmedOld + ' 字）' : ''),
        )
        reportStatus({
          phase: 'relay-applied',
          chars: body.length,
          draftChars: next.length,
          trimmedOld: trimmedOld,
          rawChars: rawLen,
          truncated: truncated,
          appended: Boolean(existing),
        })
        ack(true, 'written')
      } catch (err) {
        showToast('写入输入框失败：' + String((err && err.message) || err), true)
        reportStatus({ phase: 'relay-write-error', error: String((err && err.message) || err) })
        ack(false, String((err && err.message) || err))
      }
    }

    // ─────────────────── B→A 分支：网页端整段对话 → DSH 新会话（v1.1.0）───────────────────
    //
    // 链路：网页端「↪ 分支到 DSH」按钮 → CDP → 宿主入队（kind:'branch'）→
    //       pollRelay 取走 → applyBranch：缓存内容 → 模拟点击「新建会话」→
    //       等新会话的输入框挂载 → setDraft 写入（replace，绝不追加）。
    //
    // 🔒 容错契约：任何一步失败（找不到按钮 / 等待超时 / 写入抛错）都降级为
    //    「内容写剪贴板 + 提示手动新建会话后粘贴」—— 内容绝不丢。

    /**
     * 「新建会话」按钮的候选选择器（按优先级）。
     * ⚠️ 实测线索（用户截图）：DSH 侧边栏按钮文字是**「新会话」**—— 放最高优先级；
     *    其余按精确 → 模糊 → 类名逐级放宽。
     */
    const NEW_SESSION_SELECTORS = [
      '[aria-label="新会话"]',
      '[title="新会话"]',
      '[aria-label="新建会话"]',
      '[title="新建会话"]',
      '[aria-label="新对话"]',
      '[title="新对话"]',
      '[aria-label="New session"]',
      '[title="New session"]',
      '[aria-label="New chat"]',
      '[aria-label*="新会话"]',
      '[title*="新会话"]',
      '[aria-label*="新建"]',
      '[title*="新建"]',
      '[class*="newChat"]',
      '[class*="new-chat"]',
      '[class*="newSession"]',
      '[class*="new-session"]',
      '[class*="new_session"]',
      '[class*="create-session"]',
      '[class*="createSession"]',
    ]
    /**
     * 按钮文字匹配表。中文用「包含」匹配（按钮可能带图标 / 快捷键提示），
     * 英文用全等；多个命中时取侧边栏区域里**最靠上**的那个 —— 新建按钮在
     * 侧边栏顶部，而会话列表里也可能出现叫「新会话」的历史条目，靠上者胜。
     */
    const NEW_SESSION_TEXTS = ['新会话', '新建会话', '新对话', '新建对话', 'new chat', 'new session']

    /** 分支自动化是否正在进行（防止两条分支请求互相踩）。 */
    let branchBusy = false
    /** 分支即写状态（RelayBridge 渲染时消费，见 finishBranchWrite）。 */
    let branchArmed = false
    let branchArmedAt = 0
    /**
     * 点击「新建会话」前的六样**旧值**：动作面实例 / 输入框节点 / 页面路由 /
     * 桥挂载计数 / 会话身份指纹 / 侧边栏高亮项。
     * 之后任何一样发生变化，都是「新会话已挂载」的积极信号 ——
     * RelayBridge 与轮询两条路径都靠 detectNewSession() 汇总这些信号区分新旧会话。
     */
    let branchPrevActions = null
    let branchPrevInputEl = null
    let branchPrevUrl = ''
    let branchPrevMount = 0
    let branchPrevIdentity = ''
    let branchPrevSidebarMark = null
    /** 触发前的侧边栏会话行快照（「创建但没打开」兜底检测用）。 */
    let branchPrevRows = []
    let branchAckItem = null
    let branchWriteTries = 0
    let branchWritten = false
    /** RelayBridge 的 React 挂载计数（session 作用域每次重挂载 +1）。 */
    let branchMountCount = 0
    /** RelayBridge 最近一次观测到的会话身份指纹（从 props 提取）。 */
    let lastSessionIdentity = ''
    /** 新会话确认闩：任一积极信号成立即置位，之后允许写入/重试（当前会话即新会话）。 */
    let branchConfirmed = false
    let branchConfirmedBy = ''
    /** 写后校验令牌：内容片段 + 写入时间，防止把用户自己的输入误判为我们的写入。 */
    let branchVerifyToken = ''
    let branchVerifyAt = 0
    /** 写后校验/重试的定时器句柄（超时/成功时要清理干净）。 */
    let branchVerifyTimers = []

    /** 把待写入内容缓存到全局变量（异步流程的窗口期里内容不能只活在局部变量里）。 */
    function setPendingBranch(text) {
      try {
        window.__dshPendingBranch = text
      } catch (err) {
        /* 忽略 */
      }
    }

    function readPendingBranch() {
      try {
        return String(window.__dshPendingBranch || '')
      } catch (err) {
        return ''
      }
    }

    function clearPendingBranch() {
      try {
        window.__dshPendingBranch = null
      } catch (err) {
        /* 忽略 */
      }
    }

    // ─────────────── 侧边栏会话行快照/对比（解决「创建了但没打开」）───────────────

    /** 拍一张侧边栏会话行列表的快照（会话列表 + 会话组内的条目），返回节点+文本数组。 */
    function snapshotSidebarSessionRows() {
      const rows = []
      try {
        // 全页 button 里位于侧边栏区域（左缘 ≤420px、≤240px 高）且文字像会话名（非空）的
        const all = Array.from(document.querySelectorAll('button, [role="button"], .sidebar [class*="session"], .sidebar [class*="chat"], .sidebar [class*="conversation"]'))
        for (const el of all) {
          try {
            if (!elVisible(el)) continue
            const r = el.getBoundingClientRect()
            if (r.left > 420 || r.height > 240) continue
            // 过滤掉头部工具（新建/折叠/搜索）和面板行（插件/定时任务/扩展管理…）
            const cls = String(el.className || '').toLowerCase()
            if (/brand|toggle|search|panelrow|panellist|iconbutton/i.test(cls)) continue
            const txt = String(el.innerText || '').trim()
            if (!txt) continue
            const al = el.getAttribute('aria-label') || ''
            rows.push({ el: el, text: txt, label: al, cls: cls.slice(0, 40), x: r.left, y: r.top })
          } catch (err) {
            /* 单个失败不影响其余 */
          }
        }
        // 按 top 坐标排序，从上到下
        rows.sort(function (a, b) { return a.y - b.y })
      } catch (err) {
        /* 忽略 */
      }
      return rows
    }

    /**
     * 对比旧快照与新快照，返回新增或位置/文字发生变化的行列表。
     * 点击「新建会话」后若 DSH 内部走「创建但不打开」分支，就会有一条新行出现在
     * 侧边栏列表里（但没打开 → 无输入框），我们需要检测到它并点击打开。
     */
    function diffSessionRows(oldRows, newRows) {
      const added = []
      try {
        const key = function (r) {
          return (r.text || '') + '\t' + (r.label || '') + '\t' + Math.round(r.x) + '\t' + Math.round(r.y)
        }
        const oldSet = new Set()
        for (const r of oldRows) oldSet.add(key(r))
        for (const r of newRows) {
          if (!oldSet.has(key(r))) added.push(r)
        }
      } catch (err) {
        /* 忽略 */
      }
      return added
    }

    /**
     * 点击侧边栏里「最像新会话」的那一行（列表最靠上且文字不长的那个），
     * 让 DSH 打开这个新创建的会话。行按钮内寻找可点击的容器（优先自身，然后向上）。
     */
    function clickLatestSessionRow() {
      try {
        const rows = snapshotSidebarSessionRows()
        if (!rows.length) return false
        // 取最靠上的几个候选，优先文字短的（通常新会话默认名字短："新会话" / "chat" / 数字…）
        const candidates = rows.slice(0, 3).filter(function (r) {
          return r.text.length <= 30
        })
        const target = candidates.length ? candidates[0] : rows[0]
        if (!target || !target.el) return false
        // 直调行按钮自身的 onClick；不行就走事件序列
        let ok = invokeReactOnClick(target.el)
        if (!ok) ok = simulateRealClick(target.el)
        if (ok) {
          diag('branch-row-open: 点击了会话行（' + describeEl(target.el) + '，文字：' + target.text + '）')
          reportStatus({ phase: 'branch-row-open', target: describeEl(target.el), text: target.text })
        }
        return ok
      } catch (err) {
        diag('branch-row-open 抛错: ' + String((err && err.message) || err))
        return false
      }
    }

    /** 稍等一会儿（毫秒）。 */
    function sleepMs(ms) {
      return new Promise(function (r) {
        window.setTimeout(r, ms)
      })
    }

    /**
     * 元素看得见吗（rect 口径）。
     * ⚠️ 不用 offsetParent：position:fixed 的元素 offsetParent 也是 null，
     *    而输入区恰恰可能是 fixed 布局 —— 用它会永远「找不到输入框」（分支失败的元凶之一）。
     * 同时排除我们自己做剪贴板兜底时临时挂在屏幕外的 textarea（left < -9000）。
     */
    function elVisible(el) {
      try {
        if (!el || !el.getBoundingClientRect) return false
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.left > -9000 && r.top > -9000
      } catch (err) {
        return false
      }
    }

    /** 给诊断日志用的元素描述（tag + label + 前几个类名），写进自检文件方便定位。 */
    function describeEl(el) {
      try {
        if (!el) return ''
        const tag = String(el.tagName || '').toLowerCase()
        const al = el.getAttribute('aria-label') || el.getAttribute('title') || ''
        let cls = ''
        try {
          cls = String(el.className || '').trim().split(/\s+/).slice(0, 3).join('.')
        } catch (err) {
          cls = ''
        }
        return tag + (al ? '[label=' + al + ']' : '') + (cls ? '.' + cls : '')
      } catch (err) {
        return 'el'
      }
    }

    /** 找 DSH 的输入框元素（contenteditable / textarea，取最靠下的可见那个）。 */
    function findVisibleInputEl() {
      try {
        const els = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(
          function (el) {
            if (!el) return false
            if (el.closest && el.closest('.dsw-menu,.dsw-bubble,.dsw-toast')) return false
            return elVisible(el)
          },
        )
        return els.length ? els[els.length - 1] : null
      } catch (err) {
        return null
      }
    }

    /** 文字兜底：可点元素（button / role=button / a）的文字含「新会话」等关键词。 */
    function findNewSessionByText() {
      try {
        const els = document.querySelectorAll('button, [role="button"], a')
        let best = null // 侧边栏区域（左缘 ≤360px）里最靠上的命中
        let firstVisible = null
        for (const el of els) {
          try {
            if (el.disabled) continue
            const t = String(el.textContent || '').trim().toLowerCase()
            if (!t || t.length > 16) continue
            let hit = false
            for (const w of NEW_SESSION_TEXTS) {
              const kw = String(w).toLowerCase()
              // 中文关键词用包含（按钮可能带图标/快捷键提示），英文用全等
              if (/[\u4e00-\u9fa5]/.test(kw) ? t.indexOf(kw) >= 0 : t === kw) {
                hit = true
                break
              }
            }
            if (!hit) continue
            if (!elVisible(el)) continue
            if (!firstVisible) firstVisible = el
            const r = el.getBoundingClientRect()
            if (r.left <= 360) {
              if (!best || r.top < best.top) best = { el: el, top: r.top }
            }
          } catch (err) {
            /* 单个失败不影响其余 */
          }
        }
        if (best) return best.el
        return firstVisible
      } catch (err) {
        return null
      }
    }

    /**
     * 类名 add 兜底（严加约束，防止误点「添加附件 / 地址」之类的按钮）：
     * 只认侧边栏区域（左缘 ≤ 360px）里的小尺寸按钮（≤64px），
     * 且标签/文字得带「新 / new / create / add」；无标签的裸 + 号只认 ≤40px 的。
     */
    function findGuardedAddButton() {
      try {
        const els = document.querySelectorAll('button[class*="add"], [role="button"][class*="add"]')
        for (const el of els) {
          try {
            if (el.disabled) continue
            if (!elVisible(el)) continue
            const r = el.getBoundingClientRect()
            if (r.left > 360 || r.width > 64 || r.height > 64) continue
            const label = String(
              el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '',
            ).trim()
            if (label && !/新|new|create|add/i.test(label)) continue
            if (!label && (r.width > 40 || r.height > 40)) continue
            return el
          } catch (err) {
            /* 单个失败不影响其余 */
          }
        }
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    /**
     * **真实点击模拟**（v1.1.0：el.click() 对 React 委托事件不保险）：
     * 按真实用户的顺序派发 pointerdown → mousedown → pointerup → mouseup → click
     * （带元素中心坐标），React 17+ 挂在应用根上，靠冒泡就能触发 onClick。
     * 整串派发抛错（极老内核）才退回原生 el.click()。
     *
     * @param {Element} el 目标元素。
     * @returns {boolean} 是否派发成功。
     */
    function simulateRealClick(el) {
      if (!el) return false
      try {
        const r = el.getBoundingClientRect()
        const base = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: Math.max(1, Math.round(r.left + r.width / 2)),
          clientY: Math.max(1, Math.round(r.top + r.height / 2)),
          button: 0,
          buttons: 1,
        }
        const fire = function (type, Ctor, extra) {
          try {
            if (typeof Ctor === 'function') {
              el.dispatchEvent(new Ctor(type, Object.assign({}, base, extra || {})))
            }
          } catch (err) {
            /* 单个事件失败不影响其余 */
          }
        }
        const PE = window.PointerEvent || window.MouseEvent
        fire('pointerdown', PE)
        fire('mousedown', window.MouseEvent)
        fire('pointerup', PE, { buttons: 0 })
        fire('mouseup', window.MouseEvent, { buttons: 0 })
        fire('click', window.MouseEvent)
        return true
      } catch (err) {
        try {
          el.click()
          return true
        } catch (err2) {
          return false
        }
      }
    }

    /** 取元素上挂的 React props（__reactProps$xxx），取不到返回 null。 */
    function reactPropsOf(el) {
      try {
        const keys = Object.keys(el)
        for (let i = 0; i < keys.length; i++) {
          if (keys[i].indexOf('__reactProps$') === 0) {
            const p = el[keys[i]]
            if (p && typeof p === 'object') return p
          }
        }
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    /**
     * **直调 React 的 onClick**（本 Bug 的正解，绕过一切事件模拟问题）。
     *
     * 实测（2026-09-30 日志）：合成点击（el.click / 完整 pointer+mouse 事件序列）
     * 派发成功但 DSH 毫无反应 —— 合成事件 isTrusted=false，被 DSH 的事件系统
     * 挡掉。而按钮的 `__reactProps$` 里就挂着真实的 onClick 处理器（内部调
     * startSession），直接调用它即可：不经事件系统，任何校验都拦不住。
     * 元素自身没挂就往上找几层（有些组件把处理器挂在父级）。
     * 处理器抛错则返回 false，交给事件模拟兜底。
     *
     * @param {Element} el 目标按钮。
     * @returns {boolean} 是否成功调到了处理器。
     */
    function invokeReactOnClick(el) {
      try {
        if (!el) return false
        let node = el
        for (let i = 0; i < 6 && node && node !== document.body; i++) {
          try {
            const props = reactPropsOf(node)
            if (props && typeof props.onClick === 'function') {
              // handler 源码前 120 字符进诊断：下次失败能直接看到它到底是不是
              // startSession（例如 "() => { startSession(); }" vs "() => navigate('/')"）
              let src = ''
              try {
                src = String(props.onClick).replace(/\s+/g, ' ').slice(0, 120)
              } catch (err) {
                src = ''
              }
              diag('branch-react-call: 直调 ' + describeEl(node) + ' 的 onClick（' + src + '）')
              const ret = props.onClick({
                type: 'click',
                target: el,
                currentTarget: node,
                isTrusted: true,
                clientX: 0,
                clientY: 0,
                button: 0,
                buttons: 1,
                altKey: false,
                ctrlKey: false,
                shiftKey: false,
                metaKey: false,
                view: window,
                nativeEvent: {},
                preventDefault: function () {},
                stopPropagation: function () {},
                stopImmediatePropagation: function () {},
                persist: function () {},
              })
              // handler 返回 Promise 时把异步抛错也捞进日志（startSession 若是 async，同步 try/catch 抓不住）
              try {
                if (ret && typeof ret.then === 'function') {
                  ret.catch(function (e) {
                    diag('branch-react-call: onClick 异步抛错: ' + String((e && e.message) || e))
                  })
                }
              } catch (err) {
                /* 忽略 */
              }
              return true
            }
          } catch (err) {
            // 这个节点的处理器抛错：记下来，继续走事件模拟兜底
            diag('branch-react-call: ' + describeEl(node) + ' 的 onClick 抛错: ' + String((err && err.message) || err))
            return false
          }
          node = node.parentElement
        }
      } catch (err) {
        /* 忽略 */
      }
      return false
    }

    /** 加号图标的 path 特征：两段短描边一竖一横（如 "M12 5v14M5 12h14"），或无圆弧的短横竖笔画。 */
    function isPlusLikePath(d) {
      try {
        const s = String(d || '').trim()
        if (!s || s.length > 90) return false
        if (/[Mm][\d.\- ]+[vV][\d.\- ]*[Mm][\d.\- ]+[hH]/.test(s)) return true
        if (s.length < 48 && /[vV]/.test(s) && /[hH]/.test(s) && !/[aAcCsSqQtT]/.test(s)) return true
        return false
      } catch (err) {
        return false
      }
    }

    /**
     * svg 加号图标兜底：侧边栏区域（左缘 ≤360px、≤64px）里带加号 path 的按钮。
     * 有 aria-label/title/文字但不沾「新/add/new/create」的跳过，防误点折叠/展开钮。
     */
    function findNewSessionBySvgPlus() {
      try {
        let roots = Array.from(document.querySelectorAll('.sidebar, [class*="sidebar"], aside, nav'))
        if (!roots.length) roots = [document.body]
        for (const root of roots) {
          let btns = []
          try {
            btns = Array.from(root.querySelectorAll('button, [role="button"]'))
          } catch (err) {
            continue
          }
          for (const b of btns) {
            try {
              if (b.disabled) continue
              if (!elVisible(b)) continue
              const r = b.getBoundingClientRect()
              if (r.left > 360 || r.width > 64 || r.height > 64) continue
              const paths = b.querySelectorAll('svg path')
              if (!paths.length) continue
              let plus = false
              for (const p of paths) {
                if (isPlusLikePath(p.getAttribute('d') || '')) {
                  plus = true
                  break
                }
              }
              if (!plus) continue
              const label = String(
                b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '',
              ).trim()
              if (label && !/新|add|new|create/i.test(label)) continue
              return b
            } catch (err) {
              /* 单个失败不影响其余 */
            }
          }
        }
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    /**
     * 🔬 根因探针（临时排查代码）：找不到新建按钮时，把侧边栏（.sidebar /
     * [class*="sidebar"] / aside / nav，都没有则全页）里所有 button 的
     * className / aria-label / title / innerText / svg path 特征收集起来，
     * diag + reportStatus 双路上报 —— 看日志就能知道 DSH 的按钮到底长什么样。
     */
    function dumpSidebarButtons() {
      try {
        let roots = Array.from(
          document.querySelectorAll('.sidebar, [class*="sidebar"], aside, nav'),
        )
        if (!roots.length) roots = [document.body]
        const seen = new Set()
        const lines = []
        for (const root of roots) {
          if (!root) continue
          let btns = []
          try {
            btns = Array.from(root.querySelectorAll('button, [role="button"]'))
          } catch (err) {
            continue
          }
          for (const b of btns) {
            if (seen.has(b)) continue
            seen.add(b)
            try {
              const cls = String(b.className || '').trim().slice(0, 60)
              const al = b.getAttribute('aria-label') || ''
              const ti = b.getAttribute('title') || ''
              const txt = String(b.innerText || '').trim().slice(0, 20)
              let svg = ''
              const path = b.querySelector('svg path')
              if (path) svg = String(path.getAttribute('d') || '').slice(0, 40)
              // 顺带标注该按钮是否挂着可直调的 React onClick（下一步硬编码的依据）
              const rp = reactPropsOf(b)
              const hasClick = rp && typeof rp.onClick === 'function'
              lines.push(
                '<' + String(b.tagName).toLowerCase() + '>' +
                  ' class="' + cls + '"' +
                  ' aria-label="' + al + '"' +
                  ' title="' + ti + '"' +
                  ' text="' + txt + '"' +
                  (hasClick ? ' reactOnClick=true' : '') +
                  (svg ? ' svg-d="' + svg + '"' : ''),
              )
            } catch (err) {
              /* 单个失败不影响其余 */
            }
            if (lines.length >= 30) break
          }
          if (lines.length >= 30) break
        }
        diag(
          'branch-btn-probe: 未找到新建按钮。侧边栏 button 清单（共 ' + lines.length + ' 个）：\n  ' +
            lines.join('\n  '),
        )
        reportStatus({ phase: 'branch-btn-probe', buttons: lines })
      } catch (err) {
        diag('branch-btn-probe 抛错: ' + String((err && err.message) || err))
      }
    }

    /**
     * 官方 API 优先（不被 DOM 方案绑死）：inputActions 里若有 startSession /
     * newSession / createSession / resetSession 之类的动作，直接调它 ——
     * 这是不碰 DOM 的正路。顺带把 inputActions 的全部键名打进诊断日志，
     * 方便发现更多可用的官方动作。没有就返回 false，走 DOM 点击。
     */
    function tryOfficialNewSession() {
      try {
        const a = sessionInput
        if (!a) {
          diag('branch-actions-probe: sessionInput 为空（当前无打开的会话），跳过官方动作')
          return false
        }
        let keys = []
        try {
          keys = Object.keys(a)
        } catch (err) {
          keys = []
        }
        diag('branch-actions-probe: inputActions 键 = [' + keys.join(', ') + ']')
        reportStatus({ phase: 'branch-actions-probe', actionKeys: keys })
        for (const name of ['startSession', 'newSession', 'createSession', 'resetSession']) {
          try {
            const fn = a[name]
            if (typeof fn === 'function') {
              diag('branch-actions-probe: 调用官方动作 ' + name + '()')
              fn.call(a)
              return true
            }
          } catch (err) {
            diag('branch-actions-probe: ' + name + '() 抛错: ' + String((err && err.message) || err))
          }
        }
      } catch (err) {
        diag('branch-actions-probe 抛错: ' + String((err && err.message) || err))
      }
      return false
    }

    /**
     * 找「新建会话」按钮 —— 四级查找，逐级放宽，返回 { el, via }（via = 命中方式，进诊断日志）：
     *   ① aria-label / title / 类名特征（精确 → 模糊 → newChat / new_session / create-session…）
     *   ② 按钮文字精确匹配（新建会话 / 新对话 / New chat…）
     *   ③ 侧边栏 svg 加号图标（path 特征匹配）
     *   ④ 侧边栏 add 类小按钮（严约束）
     * 每级都优先可见的；一个可见的都没有时也接受不可见的（隐藏按钮派发 click 仍会触发）。
     * 全部落空返回 null（调用方走根因探针 + 键盘快捷键兜底）。
     */
    function findNewSessionButton() {
      // ① 选择器（可见优先）
      for (const sel of NEW_SESSION_SELECTORS) {
        try {
          const list = Array.from(document.querySelectorAll(sel))
          let invisible = null
          for (const el of list) {
            if (el.disabled) continue
            if (elVisible(el)) return { el: el, via: 'selector ' + sel }
            if (!invisible) invisible = el
          }
          if (invisible) return { el: invisible, via: 'selector(不可见) ' + sel }
        } catch (err) {
          /* 选择器非法就换下一个 */
        }
      }
      // ② 文字精确匹配
      const byText = findNewSessionByText()
      if (byText) return { el: byText, via: 'text' }
      // ③ 侧边栏 svg 加号图标
      const bySvg = findNewSessionBySvgPlus()
      if (bySvg) return { el: bySvg, via: 'svg-plus' }
      // ④ 侧边栏 add 类小按钮（严约束）
      const byAdd = findGuardedAddButton()
      if (byAdd) return { el: byAdd, via: 'add-class' }
      return null
    }

    /**
     * 收集**全部**「新建会话」候选按钮（去重、有序）。
     *
     * 🐞 2026-09-30 排序依据（实测教训）：旧逻辑在选择器级命中品牌 logo 按钮
     *    （[aria-label="新建会话"] .hHd-Xa_brand）后就返回，直调它的 onClick 成功
     *    返回但会话根本没创建 —— 品牌按钮与真正建会话的按钮不是同一个。
     *    用户截图实测的按钮文字是「新会话」，因此**文字级候选排最前**。
     *
     * @returns {Array<{el:Element, via:string}>} 候选列表。
     */
    function collectNewSessionCandidates() {
      const list = []
      const seen = new Set()
      const push = function (el, via) {
        try {
          if (!el || seen.has(el)) return
          seen.add(el)
          list.push({ el: el, via: via })
        } catch (err) {
          /* 忽略 */
        }
      }
      try {
        // ① 文字级优先（「新会话」文字按钮 —— 用户实测的那个）
        push(findNewSessionByText(), 'text')
        // ①.5 分组内创建按钮：探针实测存在「在"xxx"中新建会话」（YDXeBa 样式），
        //      是不经过顶层按钮分流的直接创建入口
        try {
          const grp = document.querySelectorAll('[aria-label*="中新建会话"], [title*="中新建会话"]')
          for (const el of grp) {
            if (el && !el.disabled) push(el, 'group-create')
          }
        } catch (err) {
          /* 忽略 */
        }
        // ② 选择器级（每级只取第一个未禁用的；可见优先）
        for (const sel of NEW_SESSION_SELECTORS) {
          try {
            const arr = Array.from(document.querySelectorAll(sel))
            let invisible = null
            let pushed = false
            for (const el of arr) {
              if (el.disabled) continue
              // 排除第三方插件的「新建」按钮（实测鲸鱼小组件的「新建模块」也命中 title*=新建）
              const tag = String(
                (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '',
              )
              if (/模块|类型|随机|动图|标签页/.test(tag)) continue
              if (elVisible(el)) {
                push(el, 'selector ' + sel)
                pushed = true
                break
              }
              if (!invisible) invisible = el
            }
            if (!pushed && invisible) {
              const tag2 = String(
                (invisible.getAttribute && (invisible.getAttribute('aria-label') || invisible.getAttribute('title'))) || '',
              )
              if (!/模块|类型|随机|动图|标签页/.test(tag2)) push(invisible, 'selector(不可见) ' + sel)
            }
          } catch (err) {
            /* 选择器非法就换下一个 */
          }
        }
        // ③ svg 加号图标 ④ add 类小按钮
        push(findNewSessionBySvgPlus(), 'svg-plus')
        push(findGuardedAddButton(), 'add-class')
      } catch (err) {
        /* 忽略 */
      }
      return list
    }

    /**
     * 触发一个候选按钮并**短验证**（400ms × 4 = 1.6s 内是否出现新会话信号）。
     * 触发方式：直调 React onClick（首选）→ 事件序列派发（兜底）。
     *
     * 🐞 2026-09-30 关键改进：DSH 的「新会话」按钮存在「创建但不打开」分支 ——
     *    触发后侧边栏多了一行新会话条目，但对话页并未切换过去（无输入框、无桥挂载）。
     *    因此验证时同时做「会话行快照对比」：一旦检测到新增行，立刻点击把它打开，
     *    打开动作本身会产生桥重挂载/身份变化/路由变化信号，进入正常写入流程。
     *
     * 有信号立刻闩住 branchConfirmed 并返回 true；没有就返回 false 让调用方换下一个候选。
     *
     * @param {Element} el 候选按钮。
     * @param {string} via 命中方式（进诊断日志）。
     * @returns {Promise<boolean>} 是否确认触发了新会话。
     */
    async function triggerAndVerify(el, via) {
      // 触发前的会话行快照（用于「创建但没打开」的兜底检测）
      const beforeRows = snapshotSidebarSessionRows()
      try {
        let fired = invokeReactOnClick(el)
        let how = 'react-call'
        if (!fired) {
          fired = simulateRealClick(el)
          how = 'event-dispatch'
        }
        diag(
          'branch-btn-clicked: ' + (fired ? '已触发' : '触发失败') +
            '（' + via + ' / ' + how + '，' + describeEl(el) + '）',
        )
        reportStatus({ phase: 'branch-btn-clicked', ok: fired, via: via + '/' + how, target: describeEl(el) })
        if (!fired) return false
        for (let i = 0; i < 4; i++) {
          await sleepMs(400)
          if (branchWritten) return true
          const ev = detectNewSession()
          if (ev.ok) {
            markBranchConfirmed('trigger:' + ev.signals.join('+'))
            diag('branch-trigger-verify: 候选 ' + via + ' 触发成功（' + ev.signals.join(' + ') + '）')
            return true
          }
          // 「创建了但没打开」检测：对比会话行快照，发现新增行立刻点开它
          const addedRows = diffSessionRows(beforeRows, snapshotSidebarSessionRows())
          if (addedRows.length) {
            diag(
              'branch-trigger-verify: 候选 ' + via + ' 触发后检测到新增会话行（' + addedRows.length + ' 条：' +
                addedRows.slice(0, 2).map(function (r) { return r.text || r.label }).join(' | ') + '）→ 点击打开',
            )
            reportStatus({ phase: 'branch-row-added', count: addedRows.length })
            clickLatestSessionRow()
            // 打开行之后再等一拍看信号（桥重挂载 / 身份变化 / 路由变化）
            await sleepMs(400)
            if (branchWritten) return true
            const ev2 = detectNewSession()
            if (ev2.ok) {
              markBranchConfirmed('row-open:' + ev2.signals.join('+'))
              diag('branch-trigger-verify: 点击新行后确认新会话（' + ev2.signals.join(' + ') + '）')
              return true
            }
            // 打开新行也没信号：继续等（可能 Lexical 还在初始化）
          }
        }
        diag('branch-trigger-verify: 候选 ' + via + ' 触发后 1.6s 内无新会话信号，换下一个')
      } catch (err) {
        diag('branch-trigger-verify 抛错: ' + String((err && err.message) || err))
      }
      return false
    }

    /**
     * 键盘兜底：按 DSH 按钮自己标注的组合发 **Ctrl+Alt+N**（实测按钮 tooltip：
     * 「新会话 Ctrl + Alt + N」），再补 Ctrl+N / Ctrl+Shift+N 两个常见变体。
     * 合成键盘事件不会触发浏览器自身的快捷键（只送达页面里的监听器），安全。
     * 派发目标用 activeElement（事件沿冒泡穿过 body 到 document ——
     * 相当于同时覆盖 document / body / React 根委托监听）。
     */
    function tryNewSessionHotkey() {
      const combos = [
        { ctrl: true, alt: true, shift: false }, // DSH 官方：Ctrl+Alt+N
        { ctrl: true, alt: false, shift: false }, // 常见变体：Ctrl+N
        { ctrl: true, alt: false, shift: true }, // 常见变体：Ctrl+Shift+N
      ]
      for (const c of combos) {
        try {
          const target =
            document.activeElement && document.activeElement.dispatchEvent
              ? document.activeElement
              : document.body || document
          const opts = {
            bubbles: true,
            cancelable: true,
            ctrlKey: Boolean(c.ctrl),
            shiftKey: Boolean(c.shift),
            altKey: Boolean(c.alt),
            metaKey: false,
            key: 'n',
            code: 'KeyN',
            keyCode: 78,
            which: 78,
          }
          target.dispatchEvent(new KeyboardEvent('keydown', opts))
          target.dispatchEvent(new KeyboardEvent('keyup', opts))
        } catch (err) {
          /* 单个组合失败不影响其余 */
        }
      }
    }

    /** 回执网页端：分支按钮在等这个（失败/超时它会兜底写剪贴板）。 */
    function ackBranch(item, ok, detail) {
      try {
        const id = item && item.id ? String(item.id) : ''
        if (!id) return
        postJson(BASE + '/relay-ack', { id: id, ok: ok === true, detail: detail || '' })
      } catch (err) {
        /* 回执失败不影响主流程 */
      }
    }

    /**
     * 从 RelayBridge 的 props 里提取「会话身份指纹」。
     * 扫描常见的 id 字段（平铺一层 + 嵌套一层），找到第一个非空字符串/数字即返回。
     * 找不到返回 ''（此时指纹信号不参与判定，其余信号仍工作）。
     */
    function extractSessionIdentity(props) {
      try {
        if (!props || typeof props !== 'object') return ''
        const direct = [
          'sessionId', 'session_id', 'chatId', 'chat_id',
          'conversationId', 'conversation_id', 'id',
        ]
        for (const k of direct) {
          const v = props[k]
          if (v != null && (typeof v === 'string' || typeof v === 'number') && String(v)) {
            return k + ':' + String(v)
          }
        }
        const nested = ['session', 'conversation', 'chat', 'sessionInfo', 'meta']
        for (const k of nested) {
          const o = props[k]
          if (o && typeof o === 'object') {
            for (const kk of ['id', 'sessionId', 'chatId', 'conversationId', 'uid', 'key']) {
              const v = o[kk]
              if (v != null && (typeof v === 'string' || typeof v === 'number') && String(v)) {
                return k + '.' + kk + ':' + String(v)
              }
            }
          }
        }
      } catch (err) {
        /* 忽略 */
      }
      return ''
    }

    /**
     * 侧边栏当前高亮（活跃）会话项的标记：优先节点身份，取不到退到文本。
     * 点击「新会话」后 DSH 会把新会话条目顶到列表并高亮（用户亲眼可见）——
     * 高亮项易位是「新会话已出现」的真实界面信号，完全不依赖 React 内部实现。
     */
    function findSidebarActiveMarker() {
      try {
        let roots = Array.from(
          document.querySelectorAll('.sidebar, [class*="sidebar"], aside, nav'),
        )
        if (!roots.length) roots = [document.body]
        for (const root of roots) {
          let hit = null
          try {
            hit = root.querySelector(
              '[aria-current="page"], [aria-current="true"], [aria-selected="true"], [data-active="true"], [data-selected="true"]',
            )
          } catch (err) {
            hit = null
          }
          if (!hit) {
            try {
              const list = Array.from(
                root.querySelectorAll('[class*="active"], [class*="selected"]'),
              )
              for (const el of list) {
                if (el && elVisible(el)) {
                  hit = el
                  break
                }
              }
            } catch (err) {
              /* 忽略 */
            }
          }
          if (hit) {
            return { node: hit, text: String(hit.textContent || '').trim().slice(0, 40) }
          }
        }
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    /**
     * 「新会话已挂载」的多信号确认（红线的核心判定）。
     *
     * 六类积极信号，**任一成立即确认**：
     *   1. bridge-remount —— RelayBridge（session 作用域）发生重挂载（React 生命周期信号）；
     *   2. identity        —— RelayBridge props 里的会话身份指纹变化；
     *   3. url             —— 页面路由变化；
     *   4. input-el        —— 可见输入框换成新节点且旧节点已从 DOM 卸载；
     *   5. sidebar-active  —— 侧边栏高亮（活跃）会话项易位（用户可见的真实界面信号）；
     *   6. actions+corroborated —— 动作面换了新实例**且**有旁证（高亮易位 / 输入框更换 /
     *      路由变化 / 触发前本来就没有会话）。单凭实例变化不算数 —— 旧会话流式重渲染
     *      也可能换实例，那正是「内容被写进旧会话」的红线事故。
     *
     * @returns {{ok:boolean, signals:string[], el:Element|null}}
     */
    function detectNewSession() {
      const signals = []
      try {
        // ① React 生命周期：session 作用域重挂载
        if (branchMountCount > branchPrevMount) signals.push('bridge-remount')
        // ② 会话身份指纹变化
        if (
          lastSessionIdentity &&
          branchPrevIdentity !== null &&
          lastSessionIdentity !== branchPrevIdentity
        ) {
          signals.push('identity:' + lastSessionIdentity)
        }
        // ③ 路由变化
        let urlChanged = false
        try {
          urlChanged = String(location.href || '') !== branchPrevUrl
        } catch (err) {
          /* 忽略 */
        }
        if (urlChanged) signals.push('url')
        // ④ 可见输入框换节点且旧节点已卸载
        const el = findVisibleInputEl()
        const prevGone = !branchPrevInputEl || !branchPrevInputEl.isConnected
        const elReplaced = Boolean(el && el !== branchPrevInputEl && prevGone)
        if (elReplaced) signals.push('input-el')
        // ⑤ 侧边栏高亮项易位
        const mark = findSidebarActiveMarker()
        const sidebarChanged = Boolean(
          mark &&
            (!branchPrevSidebarMark ||
              (mark.node !== branchPrevSidebarMark.node &&
                mark.text !== branchPrevSidebarMark.text)),
        )
        if (sidebarChanged) signals.push('sidebar-active')
        // ⑥ 动作面换实例 + 旁证
        const actionsChanged = Boolean(sessionInput && sessionInput !== branchPrevActions)
        if (
          actionsChanged &&
          (sidebarChanged || elReplaced || urlChanged || !branchPrevActions || !branchPrevInputEl)
        ) {
          signals.push('actions+corroborated')
        }
        return { ok: signals.length > 0, signals: signals, el: el }
      } catch (err) {
        return { ok: false, signals: signals, el: null }
      }
    }

    /**
     * 闩住「新会话已确认」：一旦置位不再撤回。
     * 确认后当前会话**就是**新会话，后续写入/校验重试都被允许；未确认前一律拒写。
     */
    function markBranchConfirmed(by) {
      try {
        if (branchConfirmed) return
        branchConfirmed = true
        branchConfirmedBy = String(by || '')
        diag('branch-confirmed: 新会话已确认（' + branchConfirmedBy + '）')
        reportStatus({ phase: 'branch-confirmed', by: branchConfirmedBy })
      } catch (err) {
        /* 忽略 */
      }
    }

    /**
     * 写后校验：看**可见**输入框里是否真的有我们写入的内容。
     * setDraft 走官方动作面，理论上必中；但如果动作面其实是残留引用、
     * 或 Lexical 编辑器尚未就绪，内容会落空 —— 这正是「页面切换了却没注入」的现场。
     *
     * ⚠️ 必须用「校验令牌」（内容前 12 个非空白字符）做匹配，不能只看「非空」——
     *    否则用户在新会话里随手敲的字会被误判成我们写入成功。
     * 返回 true/false；看不见输入框返回 null（无从校验，不判失败）。
     */
    function verifyBranchWrite() {
      try {
        const el = findVisibleInputEl()
        if (!el) return null
        const token = String(branchVerifyToken || '')
        if (!token) return null
        // ⚠️ 两侧必须同口径去空白再比对：令牌是 text.replace(/\s+/g,'') 的产物，
        //    而 textContent 里带着真实换行/空格，不去空白 indexOf 永远落空 ——
        //    这正是「明明写进去了，校验却四次补写后误判失败」的直接原因。
        const t = String(el.textContent || '').replace(/\s+/g, '')
        return t.indexOf(token) >= 0
      } catch (err) {
        return null
      }
    }

    /** 清理全部写后校验/重试定时器。 */
    function clearBranchVerifyTimers() {
      try {
        for (const t of branchVerifyTimers) {
          try {
            window.clearTimeout(t)
          } catch (err) {
            /* 忽略 */
          }
        }
      } catch (err) {
        /* 忽略 */
      }
      branchVerifyTimers = []
    }

    /**
     * 写后校验 + 自动重试：分别在 350ms / 900ms / 1600ms 后校验可见输入框。
     * 校验失败且仍有重试次数时，直接补一发 setDraft（replace 幂等）——
     * 专治「新会话页面出来了、但 Lexical 编辑器晚半拍才就绪」的写入落空。
     * 🔒 此时 branchConfirmed 已闩住（当前会话即新会话），补写不触红线。
     */
    function retryVerifyBranchWrite(text, how) {
      clearBranchVerifyTimers()
      const delays = [350, 900, 1600]
      for (const d of delays) {
        const t = window.setTimeout(function () {
          try {
            if (!branchWritten || !branchConfirmed) return
            const ok = verifyBranchWrite()
            if (ok === true) {
              diag('branch-verify: 写入已生效（可见输入框含校验令牌，' + d + 'ms）')
              reportStatus({ phase: 'branch-write-verified', how: how, delayMs: d })
              clearBranchVerifyTimers()
              return
            }
            if (ok === null) return // 无从校验，不判失败、不重试
            if (branchWriteTries < 5 && sessionInput && typeof sessionInput.setDraft === 'function') {
              branchWriteTries++
              try {
                sessionInput.setDraft(text)
                lastDraftWritten = text
                diag('branch-verify: 未见令牌 → 补写 #' + branchWriteTries + '（' + text.length + ' 字符）')
                reportStatus({ phase: 'branch-write-retry', tries: branchWriteTries })
              } catch (err) {
                diag('branch-verify: 补写抛错: ' + String((err && err.message) || err))
              }
            }
          } catch (err) {
            /* 忽略 */
          }
        }, d)
        branchVerifyTimers.push(t)
      }
      // 最终宣判：2600ms 后再查一次，仍不见令牌 → 直写抢救一次 → 仍不行才剪贴板
      const finalT = window.setTimeout(function () {
        try {
          if (!branchWritten || !branchConfirmed) return
          const ok = verifyBranchWrite()
          if (ok === false) {
            // 最后一搏：新会话已确认（当前可见输入框就是新会话的），桥路径写入
            // 屡次落空（setDraft 被 DSH 切换时的清场动作抹掉）时，直写可见输入框
            // 抢救一次（全选覆盖式，不会叠加），350ms 后再校验；仍不行才走剪贴板。
            diag('branch-verify: 未见令牌 → 直写可见输入框抢救一次')
            reportStatus({ phase: 'branch-direct-rescue', how: how })
            if (directWriteToVisibleComposer(text)) {
              window.setTimeout(function () {
                try {
                  if (verifyBranchWrite() === true) {
                    diag('branch-verify: 直写抢救成功')
                    reportStatus({ phase: 'branch-write-verified', how: how + '+direct-rescue' })
                    return
                  }
                  branchWritten = false
                  setPendingBranch(text)
                  diag('branch-verify: 直写抢救仍未见令牌 → 剪贴板兜底（不写旧会话）')
                  reportStatus({ phase: 'branch-verify-fail', how: how })
                  branchFallbackToClipboard(text, '自动填入新会话失败', branchAckItem, 'branch-verify-fail')
                } catch (err) {
                  /* 忽略 */
                }
              }, 350)
              return
            }
            branchWritten = false
            setPendingBranch(text)
            diag('branch-verify: 多次校验均未见令牌 → 剪贴板兜底（不写旧会话）')
            reportStatus({ phase: 'branch-verify-fail', how: how })
            branchFallbackToClipboard(text, '自动填入新会话失败', branchAckItem, 'branch-verify-fail')
          } else if (ok === true) {
            diag('branch-verify: 最终校验通过（晚渲染）')
            reportStatus({ phase: 'branch-write-verified', how: how, late: true })
          }
        } catch (err) {
          /* 忽略 */
        }
      }, 2600)
      branchVerifyTimers.push(finalT)
    }

    /**
     * 把分支内容写进当前（新）会话的输入框 —— **幂等**：
     * 先取走并清空 window.__dshPendingBranch，已被别的路径写走就返回。
     * 轮询路径（runBranchAutomation）与 RelayBridge 即写路径都走这里，
     * 谁先到谁写，绝不重复。写入一律 replace 覆盖，绝不追加（防撑爆 Lexical）。
     *
     * 🔒 中央红线闸门：branchArmed 期间必须已闩住「新会话确认」（branchConfirmed），
     *    没有证据绝不写 —— 任何路径都不可能把内容写进旧会话。
     *
     * @param {string} how 写入路径（'poll' / 'bridge'），只用于诊断日志。
     * @param {string} [fallbackText] 轮询路径的正文兜底：全局缓存被并发兜底误清时，
     *   用调用方闭包里自己持有的 body（桥路径没有闭包，不传）。
     * @returns {boolean} 是否真正写入了。
     */
    function finishBranchWrite(how, fallbackText) {
      try {
        if (branchWritten) return true
        let text = readPendingBranch()
        if (!text && typeof fallbackText === 'string' && fallbackText) {
          text = fallbackText
          diag('branch-write(' + how + '): 全局缓存已被清空，改用调用方持有的正文')
        }
        if (!text) return false // 内容已被取走（兜底已触发）或从来就没有
        if (branchWriteTries >= 5) {
          diag('branch-write(' + how + '): 重试次数用完，交给兜底')
          return false
        }
        if (!sessionInput || typeof sessionInput.setDraft !== 'function') {
          diag('branch-write(' + how + '): sessionInput 不可用，等下一拍')
          return false
        }
        // 动作面实例新鲜度不在这里卡：DSH 切会话时有时复用同一 actions 对象
        // （13:50 实测 15 拍不换实例），硬卡会永远写不了。调用方（桥即写 / 轮询）
        // 已按「新实例 / 桥重挂载 / 身份变化」三凭证放行；写入是否真落进新会话，
        // 由写后令牌校验把关，失败走剪贴板兜底，绝不写旧会话。
        // 🔒 中央红线闸门：branchArmed 期间必须已闩住「新会话确认」；
        //    未闩住时现场问一次 detectNewSession，过了就当场闩住，不过就拒写。
        if (branchArmed && !branchConfirmed) {
          const ev = detectNewSession()
          if (!ev.ok) {
            diag('branch-write(' + how + '): 无新会话信号，拒绝写入')
            return false
          }
          markBranchConfirmed('write-gate:' + ev.signals.join('+'))
        }
        branchWriteTries++
        clearPendingBranch() // 先取走内容，防止双路径重复写入
        try {
          sessionInput.setDraft(text)
          branchWritten = true
          branchArmed = false
          lastDraftWritten = text
          // 校验令牌：内容前 12 个非空白字符（区分「我们的写入」与「用户的输入」）
          branchVerifyToken = text.replace(/\s+/g, '').slice(0, 12)
          branchVerifyAt = Date.now()
          showToast('已在新会话填入分支上下文（' + text.length + ' 字符），可以直接继续。')
          diag('branch-write(' + how + '): 已写入输入框（replace），' + text.length + ' 字符')
          reportStatus({ phase: 'branch-write-success', how: how, chars: text.length })
          ackBranch(branchAckItem, true, 'written')
          // 写后校验 + 自动重试：确认内容真的落进（新）会话的可见输入框
          retryVerifyBranchWrite(text, how)
          return true
        } catch (err) {
          // 写入抛错：内容放回缓存，让其它路径（轮询 / 桥重渲染 / 兜底）接着试
          setPendingBranch(text)
          diag('branch-write(' + how + ') 抛错: ' + String((err && err.message) || err))
          reportStatus({
            phase: 'branch-write-fail',
            how: how,
            error: String((err && err.message) || err),
          })
          return false
        }
      } catch (err) {
        return false
      }
    }

    /**
     * 分支失败兜底：内容写剪贴板 + 规定提示文案。
     *
     * 🔒 红线：**只走剪贴板**，任何情况下都不碰当前输入框 ——
     *    未确认新会话时当前输入框就是旧会话，写进去就是污染聊天记录。
     *
     * @param {string} phase 上报 phase（默认 'branch-fallback'；超时路径传 'branch-timeout'）。
     */
    async function branchFallbackToClipboard(text, why, item, phase) {
      branchArmed = false
      let copied = false
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch (err) {
        copied = false
      }
      if (!copied) {
        try {
          const ta = document.createElement('textarea')
          ta.value = text
          ta.setAttribute('readonly', '')
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
          document.body.appendChild(ta)
          ta.focus()
          ta.select()
          try {
            ta.setSelectionRange(0, text.length)
          } catch (err) {
            /* 忽略 */
          }
          copied = document.execCommand('copy')
          ta.remove()
        } catch (err) {
          copied = false
        }
      }
      if (copied) {
        showToast(why + '，内容已复制到剪贴板，请手动新建会话后粘贴', true)
      } else {
        showToast(why + '，且剪贴板不可用，请重试。', true)
      }
      clearPendingBranch()
      branchAckItem = null
      ackBranch(item, false, why)
      reportStatus({ phase: phase || 'branch-fallback', reason: why, copied: copied, chars: text.length })
    }

    /**
     * 直写兜底：把内容直接写进**当前可见的**输入框元素（不经过 inputActions）。
     *
     * 使用前提（红线）：调用方必须已闩住 branchConfirmed —— 即输入框换节点 +
     * 侧边栏高亮易位等信号确认「现在看到的输入框就是新会话的」。
     *
     * 写法与 page-script.js 对网页端 contenteditable 的做法一致：
     *   textarea → 原生 value setter + input 事件（React 受控组件口径）；
     *   contenteditable（Lexical）→ focus + 全选 + execCommand('insertText')，
     *     这是往 Lexical 里灌文本的标准做法（走 beforeinput，编辑器状态会正确更新）；
     *     换行转 \r\n（Lexical 把裸 \n 当普通空白）。全选后插入 = 覆盖式，绝不叠加。
     * execCommand 失败才退 innerText + InputEvent（可见但编辑器状态可能不同步，最后手段）。
     *
     * @param {string} text 要写入的文本。
     * @returns {boolean} 是否写成功。
     */
    function directWriteToVisibleComposer(text) {
      try {
        const el = findVisibleInputEl()
        if (!el) return false
        const t = String(text == null ? '' : text)
          .replace(/\r\n/g, '\n')
          .replace(/\r/g, '\n')
          .replace(/\n/g, '\r\n')
        const tag = String(el.tagName || '').toUpperCase()
        if (tag === 'TEXTAREA' || tag === 'INPUT') {
          const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
          if (desc && desc.set) desc.set.call(el, t)
          else el.value = t
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          try {
            el.selectionStart = el.selectionEnd = t.length
          } catch (err) {
            /* 忽略 */
          }
          return true
        }
        el.focus()
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range) // 全选现有内容 → 插入即覆盖
        let ok = false
        try {
          ok = document.execCommand('insertText', false, t)
        } catch (err) {
          ok = false
        }
        if (ok) return true
        // 最后手段：直接改 innerText + 派发 input（Lexical 可能不认，但有总比没有强）
        el.innerText = t
        el.dispatchEvent(
          new InputEvent('input', { bubbles: true, data: t, inputType: 'insertText' }),
        )
        diag('branch-direct: execCommand 未生效，已退回 innerText 直写')
        return true
      } catch (err) {
        diag('branch-direct 抛错: ' + String((err && err.message) || err))
        return false
      }
    }

    /**
     * 等待新会话挂载 —— 严格按需求用 **setInterval** 轮询（500ms × ≤15 = 7.5s）。
     * 只认积极信号（输入框换了节点 / 动作面换了实例 / 路由变了），绝无「等久了就写」；
     * 每一拍的检查结果都进 diag（branch-wait #N），RelayBridge 即写完成也会立刻收尾。
     *
     * @returns {Promise<{mounted:boolean, via:string, ticks:number}>} 结果。
     */
    function waitForNewSession(body) {
      return new Promise(function (resolve) {
        let ticks = 0
        let rowClickTried = false
        let directTried = false
        const timer = window.setInterval(function () {
          ticks++
          try {
            // RelayBridge 即写路径可能已经把活干完了
            if (branchWritten) {
              window.clearInterval(timer)
              resolve({ mounted: true, via: 'bridge', ticks: ticks })
              return
            }
            const el = findVisibleInputEl()
            const ev = detectNewSession()
            if (ev.ok && !branchConfirmed) markBranchConfirmed('poll:' + ev.signals.join('+'))
            // 写入门槛（三凭证）：动作面可用 + 可见输入框 + 「React 树确已切到新会话」——
            // 动作面换了新实例 / 桥重挂载 / 会话身份指纹变化，任一成立。
            // 🐞 双向教训：只看「有动作面」会把旧引用写进虚空（13:41）；
            //    硬卡「必须换实例」又永远过不了（13:50 实测 DSH 复用同一对象）。
            //    凭证拿不准时走下面的直写兜底，绝不拿拿不准的引用盲写。
            const actionsOk = Boolean(
              sessionInput && typeof sessionInput.setDraft === 'function',
            )
            const actionsFresh = Boolean(actionsOk && sessionInput !== branchPrevActions)
            const remounted = branchMountCount > branchPrevMount
            const identityChanged = Boolean(
              lastSessionIdentity &&
                branchPrevIdentity &&
                lastSessionIdentity !== branchPrevIdentity,
            )
            const ready = Boolean(
              el && actionsOk && (actionsFresh || remounted || identityChanged),
            )
            if (ticks === 1 || ev.ok || ticks % 3 === 0) {
              diag(
                'branch-wait #' + ticks + ': ready=' + ready +
                  ' confirmed=' + branchConfirmed +
                  ' actionsOk=' + actionsOk +
                  ' fresh=' + actionsFresh +
                  ' remount=' + remounted +
                  ' identity=' + identityChanged +
                  (ev.signals.length ? ' signals=[' + ev.signals.join(',') + ']' : ''),
              )
            }
            if (ready && ev.ok) {
              window.clearInterval(timer)
              resolve({ mounted: true, via: ev.signals.join('+'), ticks: ticks })
              return
            }
            // 🔧 直写兜底：新会话已确认（现在可见的输入框就是新会话的），但桥迟迟
            //    不给「已切换」凭证（新会话视图可能没有会话头 → session 作用域插槽
            //    被卸载，动作面一直空着）—— 第 3 拍（1.5s）起直接把内容写进可见
            //    输入框（全选覆盖式），写完统一走令牌校验。红线：必须先 confirmed。
            if (!directTried && branchConfirmed && el && !ready && ticks >= 3) {
              directTried = true
              const text = readPendingBranch() || String(body || '')
              if (text) {
                diag('branch-direct: 第 ' + ticks + ' 拍仍无桥凭证 → 直写可见输入框（' + text.length + ' 字符）')
                reportStatus({ phase: 'branch-direct-write', ticks: ticks, chars: text.length })
                if (directWriteToVisibleComposer(text)) {
                  branchWritten = true
                  branchArmed = false
                  clearPendingBranch()
                  lastDraftWritten = text
                  branchVerifyToken = text.replace(/\s+/g, '').slice(0, 12)
                  branchVerifyAt = Date.now()
                  showToast('已在新会话填入分支上下文（' + text.length + ' 字符），可以直接继续。')
                  reportStatus({ phase: 'branch-write-success', how: 'direct', chars: text.length })
                  ackBranch(branchAckItem, true, 'written')
                  retryVerifyBranchWrite(text, 'direct')
                  window.clearInterval(timer)
                  resolve({ mounted: true, via: 'direct', ticks: ticks })
                  return
                }
              }
            }
            // 「创建但没打开」兜底：每 3 拍做一次会话行快照对比，发现新增行就点开它
            // （新行打开 = 桥重挂载/身份/路由信号，下一拍 ready+ev.ok 就会放行）
            if (!rowClickTried && ticks % 3 === 0) {
              try {
                const added = diffSessionRows(branchPrevRows, snapshotSidebarSessionRows())
                if (added.length) {
                  rowClickTried = true
                  diag(
                    'branch-wait #' + ticks + ': 检测到新增会话行（' + added.length + ' 条）→ 点击打开',
                  )
                  reportStatus({ phase: 'branch-row-added', count: added.length, ticks: ticks })
                  clickLatestSessionRow()
                }
              } catch (err) {
                /* 忽略 */
              }
            }
            // 每 5 拍刷一次状态文件里的 branch-wait-mount（带进度）
            if (ticks % 5 === 0) {
              reportStatus({ phase: 'branch-wait-mount', ticks: ticks })
            }
          } catch (err) {
            diag('branch-wait #' + ticks + ' 抛错: ' + String((err && err.message) || err))
          }
          if (ticks >= 15) {
            window.clearInterval(timer)
            resolve({ mounted: false, via: 'timeout', ticks: ticks })
          }
        }, 500)
      })
    }

    /**
     * 新建会话自动化：**先武装** → 官方 API / DOM 按钮 + 真实点击 / 快捷键
     * → setInterval 轮询等新会话（证据判定）→ 写入（中央红线闸门 + 写后校验）。
     *
     * 诊断链路（%TEMP%\dsh-deepseek-web-relay-status.json 的 phase 字段）：
     *   branch-start → branch-actions-probe → branch-btn-found → branch-btn-clicked
     *   → branch-wait-mount → branch-write-success → branch-write-verified
     *   ｜ branch-timeout / branch-verify-fail / branch-fallback
     *
     * 🐞 本轮修复的根因：点击派发是**同步**的，React 会在 dispatchEvent 内就完成
     *    新会话挂载并渲染 RelayBridge —— 旧版在点击**之后**才置空 sessionInput、
     *    才置 branchArmed，把刚挂载好的新会话动作面一起抹掉了，之后再无桥渲染
     *    回填，轮询永远 not ready → 超时（正是「页面切换了却没注入」的现场）。
     *    修法：① 先武装再触发（同步挂载当场即写）；② 绝不清空 sessionInput，
     *    旧会话动作面靠「多信号确认 + 确认闩」识别（detectNewSession / branchConfirmed）。
     *
     * 🔒 红线：任何异常 / 超时 / 写入失败 / 校验失败，都只走
     *    「剪贴板 + 提示『自动填入新会话失败，内容已复制到剪贴板，请手动新建会话后粘贴』」，
     *    绝不把内容写入当前正在聊的旧会话。
     */
    async function runBranchAutomation(body, item) {
      // 触发前的六样「旧值」快照：输入框节点、动作面实例、当前路由、
      // 桥挂载计数、会话身份指纹、侧边栏高亮项
      branchPrevInputEl = findVisibleInputEl()
      branchPrevActions = sessionInput
      branchPrevUrl = String(location.href || '')
      branchPrevMount = branchMountCount
      branchPrevIdentity = lastSessionIdentity
      branchPrevSidebarMark = findSidebarActiveMarker()
      branchPrevRows = snapshotSidebarSessionRows()
      reportStatus({
        phase: 'branch-start',
        hasPrevInput: Boolean(branchPrevInputEl),
        hasPrevActions: Boolean(branchPrevActions),
        url: branchPrevUrl.slice(0, 120),
        mount: branchPrevMount,
        identity: branchPrevIdentity || '(none)',
        rows: branchPrevRows.length,
      })

      // ① **先武装**：新会话可能在点击派发的同一同步流程里就挂载，RelayBridge
      //    渲染时要能当场即写（branchArmed 必须在这之前就是 true）
      branchArmed = true
      branchArmedAt = Date.now()

      // ② 官方 API 优先：inputActions 里若有 startSession 之类的动作直接调（不碰 DOM），
      //    调完同样短验证（1.6s 内要看到新会话信号，否则视为无效、继续走按钮链）
      let triggered = false
      if (tryOfficialNewSession()) {
        triggered = true
        diag('branch-btn-clicked: 官方动作已调用（不经 DOM）')
        reportStatus({ phase: 'branch-btn-clicked', ok: true, via: 'official-api' })
        for (let i = 0; i < 4; i++) {
          await sleepMs(400)
          if (branchWritten) break
          const ev = detectNewSession()
          if (ev.ok) {
            markBranchConfirmed('official:' + ev.signals.join('+'))
            break
          }
        }
      }

      // ③ 候选按钮链：文字级「新会话」排最前（用户实测的有效按钮），逐个
      //    「触发 + 1.6s 短验证」，确认新会话信号立刻停；全不灵再走快捷键。
      //    旧逻辑的坑：找到第一个按钮就点、然后干等 7.5s —— 点错按钮（品牌 logo）
      //    时整个等待期全部浪费且无任何补救。
      if (!branchConfirmed && !branchWritten) {
        const candidates = collectNewSessionCandidates()
        diag(
          'branch-candidates: 共 ' + candidates.length + ' 个候选：' +
            candidates.map(function (c) { return c.via + '→' + describeEl(c.el) }).join(' | '),
        )
        reportStatus({ phase: 'branch-btn-found', count: candidates.length })
        for (const c of candidates) {
          if (branchConfirmed || branchWritten) break
          triggered = true
          await triggerAndVerify(c.el, c.via)
        }
      }

      // ④ 官方动作 / 全部候选都没确认 → 根因探针（侧边栏按钮全量转储）+ 快捷键兜底
      if (!branchConfirmed && !branchWritten) {
        dumpSidebarButtons()
        diag('branch-hotkey: 改发 Ctrl+N / Ctrl+Shift+N')
        reportStatus({ phase: 'branch-hotkey' })
        tryNewSessionHotkey()
        await sleepMs(400)
      }

      // ⑤ ⚠️ 绝不清空 sessionInput：同步挂载的新动作面就接在上面。
      //    旧会话动作面靠 detectNewSession（多信号确认 + 确认闩）识别，写不进旧的。

      // ⑥ setInterval 轮询等待新会话挂载（500ms × ≤15 = 7.5s），只认积极信号
      reportStatus({ phase: 'branch-wait-mount', triggered: triggered, ticks: 0 })
      const r = await waitForNewSession(body)
      branchArmed = false
      if (branchWritten) return // 即写已完成（校验重试在后台继续）

      if (r.mounted) {
        diag('branch-mounted: tick ' + r.ticks + '，信号 ' + r.via)
        if (finishBranchWrite('poll', body)) return // 上报 branch-write-success + 写后校验
        // 新会话已确认但写入未成功：进入「确认后写入重试循环」——
        // 常见于 Lexical 编辑器晚于动作面就绪（setDraft 暂不可用的半拍）。
        const deadline = Date.now() + 4000
        while (Date.now() < deadline && !branchWritten) {
          await sleepMs(400)
          if (branchWritten) break
          finishBranchWrite('poll-retry', body)
        }
        if (branchWritten) return
        // 确认后仍写不进去：剪贴板兜底（当前会话就是新会话，但写入屡败，不硬塞）
        await branchFallbackToClipboard(
          readPendingBranch() || body,
          '自动填入新会话失败',
          item,
          'branch-fallback',
        )
        return
      }

      // ⑦ 🔒 超时强制拦截（7.5s 无任何新会话信号）：只走剪贴板 + 规定提示，绝不写旧会话
      reportStatus({ phase: 'branch-timeout', ticks: r.ticks, triggered: triggered })
      await branchFallbackToClipboard(
        readPendingBranch() || body,
        '自动填入新会话失败',
        item,
        'branch-timeout',
      )
    }

    /** 处理一条分支消息（pollRelay 里调用）。每一步都写诊断，卡在哪一步一目了然。 */
    function applyBranch(item) {
      try {
        // ⚠️ 硬刷新会把轮询游标清零，宿主内存队列里的旧分支消息会被重放
        //    （现场：branchSeq 3~8 循环重放、连环弹失败提示）。超过 20 秒的
        //    直接跳过 —— 不启动自动化、不清缓存、不弹提示。
        const at = item && item.meta && item.meta.at ? Number(item.meta.at) : 0
        if (at && Date.now() - at > 20000) {
          diag(
            '跳过过期的分支消息（branchSeq ' + String(item && item.branchSeq) + '，' +
              Math.round((Date.now() - at) / 1000) + ' 秒前点击，属刷新后重放）',
          )
          reportStatus({
            phase: 'branch-stale-skip',
            branchSeq: item && item.branchSeq,
            ageMs: Date.now() - at,
          })
          ackBranch(item, false, '消息已过期（页面刷新后重放的旧请求）')
          return
        }

        const rawChars = item && typeof item.text === 'string' ? item.text.length : 0
        diag('收到分支请求（branchSeq ' + String(item && item.branchSeq) + '，原文 ' + rawChars + ' 字符）')
        reportStatus({ phase: 'branch-received', branchSeq: item && item.branchSeq, rawChars: rawChars })

        // 分支带整段上下文：按 branchMaxChars（默认 5000）截断，不能走划词的 2000
        const cap = Number(config.branchMaxChars) > 0 ? Number(config.branchMaxChars) : 5000
        const body = safeCleanText(item && item.text, cap)
        if (!body) {
          showToast('网页端这次没抓到分支内容。', true)
          reportStatus({ phase: 'branch-empty', rawChars: rawChars })
          ackBranch(item, false, '内容为空')
          return
        }

        // 上一条分支还在跑：本条自己走剪贴板兜底。
        // ⚠️ 绝不能调 branchFallbackToClipboard —— 它会 clearPendingBranch()，
        //    把**正在运行的自动化**赖以写入的缓存清掉（上轮「挂载成功却超时」的根因）。
        if (branchBusy) {
          diag('分支忙，本条直接走剪贴板兜底（不触碰正在进行的分支缓存）')
          ackBranch(item, false, '已有分支正在进行')
          copyTextBestEffort(body).then(function (ok) {
            showToast(
              '自动填入新会话失败（已有分支正在进行），内容已复制到剪贴板，请手动新建会话后粘贴',
              true,
            )
            reportStatus({ phase: 'branch-busy-fallback', copied: ok, chars: body.length })
          })
          return
        }
        branchBusy = true
        branchAckItem = item || null
        branchWriteTries = 0
        branchWritten = false
        // 新一轮分支：清掉上一轮的确认闩与校验令牌/定时器，防止旧状态干扰
        branchConfirmed = false
        branchConfirmedBy = ''
        branchVerifyToken = ''
        branchVerifyAt = 0
        clearBranchVerifyTimers()

        // ① 缓存到全局变量：后面是异步流程，内容不能只活在局部变量里；
        //    RelayBridge 的即写路径也从这里取
        setPendingBranch(body)
        reportStatus({ phase: 'branch-cached', chars: body.length })
        showToast('收到分支请求（' + body.length + ' 字符），正在新建会话…')

        // ② 新建会话自动化（自带全部容错与逐步诊断，绝不抛出）
        runBranchAutomation(body, item)
          .catch(function (err) {
            return branchFallbackToClipboard(
              readPendingBranch() || body,
              String((err && err.message) || err),
              item,
            ).then(function () {})
          })
          .finally(function () {
            branchBusy = false
          })
      } catch (err) {
        // 理论上进不来（runBranchAutomation 自带容错）；真进来了也兜底，内容不丢
        branchFallbackToClipboard(
          String((item && item.text) || ''),
          String((err && err.message) || err),
          item,
        ).catch(function () {})
      }
    }

    let relaySince = 0
    let relayTimer = null

    /** 轮询宿主，取走新的接力内容。 */
    async function pollRelay() {
      try {
        const r = await fetch(BASE + '/relay?since=' + relaySince, { cache: 'no-store' })
        if (!r.ok) return
        const data = await r.json()
        for (const it of data.items || []) {
          relaySince = Math.max(relaySince, Number(it.seq) || 0)
          if (it.kind === 'relay') applyRelay(it)
          else if (it.kind === 'branch') applyBranch(it)
          else if (it.kind === 'error') showToast('网页端提示：' + (it.detail || '未知原因'), true)
        }
        if (typeof data.seq === 'number' && data.seq > relaySince) relaySince = data.seq
      } catch (err) {
        /* 宿主没起来 / 正在重启，下一轮再试 */
      }
    }

    function startRelayPolling() {
      if (relayTimer) return
      if (config.relay === false) {
        diag('relay 已关闭，不启动接力轮询')
        return
      }
      // 轮询间隔 1500ms → 800ms：网页端「等回执」的预算里，这一项占了最大头
      // （最坏要等一整个周期）。800ms 让往返更快，代价只是本地小 HTTP 请求变密一点。
      relayTimer = window.setInterval(pollRelay, 800)
      pollRelay()
      diag('接力轮询已启动（每 1.5s）')
    }

    // ─────────────── 事件隔离：绝不让点击传到 DSH 的品牌按钮 ───────────────
    //
    // 🐞 修复的 bug：切换模式会把「当前正在进行的会话」顶掉，变成一个全新的新对话。
    //
    // 原因不在本插件调了什么 API（本插件从头到尾**没有**调用任何 DSH 的
    // 「新建/切换/重置会话」接口），而在 DOM：
    //
    //   @deepseek-ai/dsh-client-ui-sidebar 的 SidebarRoot 里，品牌行 logoRow 的
    //   第一个子节点是这样一个按钮：
    //
    //     <button class="…brand" aria-label="新建会话"
    //             onClick={() => { startSession(); }}>
    //       <span class="…brandIdentity" aria-hidden="true">
    //         <span class="…brandMark">{slot: sidebar.brand.mark}</span>
    //         <span class="…brandName">{slot: sidebar.brand.name}</span>   ← 我们注册在这
    //       </span>
    //     </button>
    //
    //   也就是说：**本插件的下拉切换器是那个「新建会话」按钮的后代节点**。
    //   展开按钮当初加了 stopPropagation 所以没事；但两个菜单项没加 —— 点
    //   「DeepSeek Relay」/「DSH 默认模式」时 click 冒泡到品牌按钮 → startSession()
    //   → 当前会话被换掉，输入框里没发出去的草稿一起丢。
    //
    // 修法：把插件自己 UI 区域内的指针/点击事件在**冒泡阶段**截住。
    //   · 只 stopPropagation，不动 capture 阶段 —— 插件内部按钮的 onClick 照常触发；
    //   · 不使用 nativeEvent.stopImmediatePropagation()，避免误伤 DSH 自己的
    //     全局 document 监听（例如「点空白处关菜单」那类逻辑）。
    function stopAll(ev) {
      if (!ev) return
      try {
        if (typeof ev.stopPropagation === 'function') ev.stopPropagation()
      } catch (err) {
        /* 忽略 */
      }
    }



    // ─────────────────────────── apply ───────────────────────────
    // 只依赖 slots：注册 UI 用的。不需要 layout（我们不切换 DSH 的中央面板）。
    const inject = ['slots']

    /**
     * @param {any} ctx 客户端根上下文。
     */
    function apply(ctx) {
      const registered = []
      diag('apply() 进入')
      diag('ctx.slots = ' + typeof (ctx && ctx.slots))

      // 用 slots.inject 而不是直接 register：ui-sidebar / brand-official
      // 可能比我们晚加载，inject 会等到该 slot 被声明为止。
      //
      // ⚠️ 实测踩到的坑（这是「看不到下拉框」的真正原因）：
      //
      // `sidebar.brand.name` 是 **single** slot，而官方插件
      // dsh-client-ui-brand-official 已经以 **priority 0** 占了它。此时直接
      // register 会**抛异常**，而不是自动替换：
      //
      //   single slot "sidebar.brand.name" already has a registration at
      //   priority 0 (registered by …) — register at a different priority to
      //   shadow it (lowest renders)
      //
      // DSH 的规则（见 dsh-cordis-client-runner/lib/types/client/runtime.d.ts）：
      //   「A later registration receives a lower priority」+「lowest renders」
      // 也就是说 single slot 靠 **priority 数字最小者胜出**，必须显式给一个比
      // 官方更小的数（负数）才能把它盖掉。
      //
      // ─────────────── 左侧边栏原生菜单项（v1.7 起）───────────────
      //
      // 旧的「顶部下拉切换按钮」已删除：它是挂到 `sidebar.brand.name` 这个 single slot
      // 上的，而该 slot 位于官方"新建会话"按钮的子树里 —— 桌面壳会把它整支隐藏
      // （实测：元素在 DOM 里、内联样式 + !important 都压不过，display 恒为 none）。
      //
      // 改为注册进 `sidebar.panellist`（kind:"list"）—— 就是「扩展管理 / 定时任务 / IM」
      // 那一列，DSH 自己会渲染行按钮、图标与标题，我们只提供条目。
      //
      // 条目选项契约（读 DSH 侧边栏源码得出）：{ id, order, label }
      //   · id    —— 该条目的 slot id（面板唯一标识）
      //   · order —— 排序，越小的越靠上
      //   · label —— 字符串或 () => 字符串（resolveSlotLabel 直接返回它）
      // 组件会收到 props：{ size, active, selectPanel, toggleSidebar, ... }
      //   · selectPanel(id) 只做一件事：把 panelInfo.activePanelId 设为 id（点亮/激活）。
      //     右侧内容属于第二步（需要 ctx.sidebarRightTabs），本步只保证菜单项出现且可点。
      const PANEL_ID = 'dsh-deepseek-web-relay-panel'

      // 面板图标：一个极简的"对话气泡 + 折线"轮廓，呼应 DeepSeek Relay（不使用任何商标图形）
      function DeepSeekChatIcon(props) {
        const size = props && props.size ? props.size : 18
        return React.createElement(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          React.createElement('path', { d: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.2-4.2A8 8 0 1 1 21 12Z' }),
          React.createElement('path', { d: 'M8.5 11h7M8.5 14.5h4.5' }),
        )
      }

      /**
       * 侧边栏菜单项本体。
       *
       * DSH 会把这一行包成自己的按钮（onClick → selectPanel(id)），我们只负责画图标；
       * 但"点击打开 DeepSeek 窗口"这个动作由**本组件自己**处理：
       *   · 在冒泡阶段先于外层按钮拿到点击；
       *   · stopPropagation 阻止再往上冒泡（避免影响侧边栏自身的其他监听）；
       *   · 复用既有的 openWeb()（Tauri 优先 → 宿主 /open 回退），**不新增任何通信逻辑**。
       * 任何异常都只写日志 + 弹提示，绝不抛到渲染树里。
       *
       * @param {{size?:number, active?:boolean}} props slot 注入的 props。
       * @returns {any} React 元素。
       */
      function DeepSeekChatPanelItem(props) {
        try {
          const size = props && props.size ? props.size : 18
          const onActivate = (ev) => {
            try {
              if (ev && ev.stopPropagation) ev.stopPropagation()
            } catch (err) {
              /* 忽略 */
            }
            try {
              showToast('正在打开 DeepSeek Relay 窗口…')
              Promise.resolve(openWeb()).then(
                (r) => {
                  try {
                    if (r && r.ok) {
                      showToast('DeepSeek Relay 窗口已就绪' + (r.mode ? '（' + r.mode + '）' : ''))
                    } else {
                      showToast('打开失败：' + ((r && r.detail) || '未知原因'), true)
                    }
                  } catch (err) {
                    /* 忽略 */
                  }
                },
                (err) => {
                  try {
                    showToast('打开失败：' + String((err && err.message) || err), true)
                  } catch (e) {
                    /* 忽略 */
                  }
                },
              )
            } catch (err) {
              try {
                showToast('打开失败：' + String((err && err.message) || err), true)
              } catch (e) {
                /* 忽略 */
              }
            }
          }
          /**
           * 🐞 2026-09-27 修复「点了没反应」：
           *   实测（探针）——图标节点确实挂载了（16×16、pointerEvents:auto），
           *   但 React 的 onClick **从未被调用**：DSH 的行按钮自己用 React 委托处理点击，
           *   我们挂在 span 上的合成事件收不到。
           *   最小修法：不用 React 合成事件，改用**原生 DOM 监听器直接绑在图标节点上**
           *   （callback ref 负责绑定与解绑）。原生监听器一定命中，与 React 委托无关。
           *
           * @param {any} node 图标 span 节点（React 传入）。
           * @returns {void}
           */
          /**
           * 把点击监听同时绑到**图标节点**和它所在的**整行按钮**上，并上报诊断。
           *
           * 为什么要两处都绑：图标只有 16×16，用户很可能点在文字区域（那属于外层
           * `<button class="…panelRow">`）；而且外层按钮我们用 closest('button') 现找。
           * 诊断（handlers 数组）会写进自检文件，用来确认"到底有没有一个 handler 被调用"。
           *
           * @param {any} node 图标 span 节点（React ref 传入）。
           * @returns {void}
           */
          const bindGlyph = (node) => {
            try {
              if (!node) return
              if (node.__dswBound) return
              node.__dswBound = true
              node.__dswHandlers = []
              const bound = []
              /** 绑一个节点（找到即绑，天然避开"ref 触发时外层还没生成"的时序问题）。 */
              const attach = (el, where) => {
                if (!el || el.__dswClickBound) return
                el.__dswClickBound = true
                bound.push(where)
                try {
                  el.addEventListener(
                    'click',
                    (ev) => {
                      try {
                        node.__dswHandlers.push(where + '@' + Date.now())
                        reportStatus({
                          phase: 'click-fired',
                          clickFired: {
                            where: where,
                            count: node.__dswHandlers.length,
                            targetCls: String((ev && ev.target && ev.target.className) || '').slice(0, 40),
                          },
                        })
                      } catch (e) {
                        /* 忽略 */
                      }
                      onActivate(ev)
                    },
                    true,
                  )
                } catch (e) {
                  /* 单个节点绑定失败不影响另一个 */
                }
              }
              attach(node, 'glyph')
              const tryRow = () => {
                try {
                  const row = node.closest && node.closest('button')
                  if (row && row !== node) {
                    attach(row, 'row')
                    return true
                  }
                } catch (e) {
                  /* 忽略 */
                }
                return false
              }
              // ref 触发时外层行按钮可能还没生成 → 最多补试 5 次
              if (!tryRow()) {
                let tries = 0
                const t = window.setInterval(() => {
                  tries++
                  if (tryRow() || tries >= 5) window.clearInterval(t)
                }, 300)
              }
              reportStatus({ phase: 'glyph-bound', bound: { targets: bound, glyphSize: size } })
            } catch (err) {
              /* 绑定失败不影响渲染 */
            }
          }
          return React.createElement(
            'span',
            {
              className: 'dsw-panel-glyph',
              ref: bindGlyph,
              title: '打开 DeepSeek Relay 窗口',
            },
            React.createElement(DeepSeekChatIcon, { size: size }),
          )
        } catch (err) {
          try {
            console.error('[dsh-deepseek-web-relay] 菜单项渲染失败', err)
          } catch (e) {
            /* 忽略 */
          }
          return null
        }
      }

      try {
        ctx.slots.inject('sidebar', () => {
          // ⚠️ 实测：inject('sidebar') 回调触发时，子表 sidebar.panellist **可能还没声明**
          // （报错：slot "sidebar.panellist" is not declared）。所以这里带退避重试，
          // 最多试 8 次；只有全部失败才写诊断（顺带把可见 slot 名列出来便于排查）。
          let attempt = 0
          const MAX_ATTEMPTS = 8
          const tryRegister = () => {
            attempt++
            try {
              const disposer = ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 40,
                  label: 'DeepSeek Relay',
                },
                DeepSeekChatPanelItem,
              )
              registered.push('sidebar.panellist#' + PANEL_ID)
              diag('已注册左侧菜单项 DeepSeek Relay（第 ' + attempt + ' 次尝试成功）')
              reportStatus({ registered: registered, phase: 'panellist-registered' })
              // 注册后做一次 DOM 自检（菜单项是 DSH 自己渲染的，我们只能看结果）
              try {
                window.setTimeout(() => {
                  try {
                    const hit = Array.from(document.querySelectorAll('button')).find((b) =>
                      String(b.textContent || '').includes('DeepSeek Relay'),
                    )
                    const r = hit ? hit.getBoundingClientRect() : null
                    diag(
                      '菜单项自检: ' +
                        (hit ? '已出现在侧边栏 ✓' : '未找到（侧边栏可能是收起态，展开后可见）') +
                        (r ? '，尺寸 ' + Math.round(r.width) + 'x' + Math.round(r.height) : ''),
                    )
                    /* 【临时排查 · 2026-09-27】点击链路诊断：
                       ① 组件是否真的挂载（有没有 .dsw-panel-glyph 节点）
                       ② 在 document 捕获阶段监听一次点击，看点击究竟落在谁身上 */
                    let glyphInfo = null
                    try {
                      const g = document.querySelector('.dsw-panel-glyph')
                      const gr = g ? g.getBoundingClientRect() : null
                      const gcs = g ? window.getComputedStyle(g) : null
                      glyphInfo = g
                        ? {
                            w: Math.round(gr.width),
                            h: Math.round(gr.height),
                            x: Math.round(gr.left),
                            y: Math.round(gr.top),
                            pointerEvents: gcs.pointerEvents,
                            display: gcs.display,
                          }
                        : 'NO-NODE（组件没有挂载到 DOM）'
                    } catch (e) {
                      glyphInfo = 'err: ' + String((e && e.message) || e)
                    }
                    let target = null
                    try {
                      const t = hit || document.querySelector('.dsw-panel-glyph')
                      target = t
                        ? { tag: t.tagName, cls: String(t.className || '').slice(0, 50), role: t.getAttribute('role') }
                        : null
                    } catch (e) {
                      /* 忽略 */
                    }
                    reportStatus({
                      registered: registered,
                      phase: 'panellist-dom-check',
                      menuItem: hit
                        ? { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }
                        : null,
                      glyph: glyphInfo,
                      menuTarget: target,
                    })
                    // 捕获阶段监听一次真实点击，记录命中的元素（点完菜单项就会写进自检）
                    try {
                      if (!window.__dswClickProbe) {
                        window.__dswClickProbe = true
                        document.addEventListener(
                          'click',
                          (ev) => {
                            try {
                              const el = ev.target
                              const inMenu =
                                el &&
                                el.closest &&
                                el.closest('[data-slot="sidebar.panellist"], .dsw-panel-glyph')
                              if (!inMenu) return
                              reportStatus({
                                phase: 'click-hit',
                                clickHit: {
                                  tag: el.tagName,
                                  cls: String(el.className || '').slice(0, 60),
                                  isGlyph: Boolean(el.closest && el.closest('.dsw-panel-glyph')),
                                  defaultPrevented: ev.defaultPrevented,
                                },
                              })
                            } catch (e) {
                              /* 忽略 */
                            }
                          },
                          true,
                        )
                      }
                    } catch (e) {
                      /* 忽略 */
                    }
                  } catch (e) {
                    diag('菜单项自检抛错: ' + String((e && e.message) || e))
                  }
                }, 3000)
              } catch (err) {
                /* 自检失败不影响功能 */
              }
              return disposer
            } catch (err) {
              const msg = String((err && err.message) || err)
              if (attempt < MAX_ATTEMPTS) {
                diag('注册左侧菜单项第 ' + attempt + ' 次未成功（' + msg + '），稍后重试')
                window.setTimeout(tryRegister, 250 * attempt)
                return undefined
              }
              diag('注册左侧菜单项失败（已重试 ' + attempt + ' 次）: ' + msg)
              try {
                const names = (ctx.slots.entries ? ctx.slots.entries() : [])
                  .map((e) => (e && e.options && e.options.name) || (e && e.name) || '?')
                  .filter((n) => String(n).includes('sidebar'))
                diag('当前可见的 sidebar* slot: ' + (names.length ? names.join(', ') : '（读不到）'))
              } catch (e) {
                /* 诊断失败无所谓 */
              }
              reportStatus({ registered: registered, phase: 'panellist-register-failed' })
              return undefined
            }
          }
          return tryRegister()
        })
        diag('左侧菜单项注入已提交（等 sidebar slot 声明）')
      } catch (err) {
        diag('左侧菜单项注入抛错: ' + String((err && err.message) || err))
      }

      // A→B 的界面部分（划词气泡 + 提示）挂在 **root** 的浮层槽上。
      // shell.overlay 是 kind:"list" + scope:"root"，是「整个框架之上的浮动层」，
      // 而且是 click-through 的（条目自己决定要不要接收指针事件）——
      // 正好适合一个只在划词时才出现的小气泡。
      // 挂 root 而不是 session：这样没开会话也能用（气泡不需要 DSH 的输入框）。
      //
      // ⚠️ **list 类 slot 注册必须带 `id`**，否则 SlotCore 直接抛
      //    `list slot "..." requires options.id`（源码里 case "list" 分支硬校验）。
      //    这个坑踩过：注册失败但异常被吞掉，界面就是「什么都不出现」。
      try {
        ctx.slots.inject('shell.overlay', () => {
          diag('shell.overlay 已声明 → 注册划词浮层')
          try {
            ctx.slots.register({ name: 'shell.overlay', id: 'dsh-deepseek-web-relay-overlay' }, DshOverlay)
            registered.push('shell.overlay#dsh-deepseek-web-relay-overlay')
            diag('划词浮层注册完成')
          } catch (err) {
            diag('划词浮层注册抛错: ' + String((err && err.message) || err))
          }
          reportStatus({ registered, phase: 'overlay-registered' })
        })
        diag('划词浮层注入已提交（等 slot 声明）')
      } catch (err) {
        diag('划词浮层注入抛错: ' + String((err && err.message) || err))
      }

      // 上下文接力的常驻桥：挂在 session 作用域的 list slot 上。
      // list 是追加语义，不会顶掉别人；拿到的 props.inputActions 里有 setDraft。
      // 同样必须带 `id`（见上）。注册成功与否只在回调里记，免得把失败当成功。
      try {
        ctx.slots.inject('conversation.session.header.utilities', () => {
          diag('conversation.session.header.utilities 已声明 → 注册接力桥')
          try {
            ctx.slots.register(
              { name: 'conversation.session.header.utilities', id: 'dsh-deepseek-web-relay-bridge' },
              RelayBridge,
            )
            registered.push('conversation.session.header.utilities#dsh-deepseek-web-relay-bridge')
            diag('接力桥注册完成')
          } catch (err) {
            diag('接力桥注册抛错: ' + String((err && err.message) || err))
          }
          reportStatus({ registered, phase: 'bridge-registered' })
        })
        diag('接力桥注入已提交（等 slot 声明）')
      } catch (err) {
        diag('接力桥注入抛错: ' + String((err && err.message) || err))
      }

      // 开始轮询宿主，接收网页端发来的接力内容
      try {
        startRelayPolling()
      } catch (err) {
        diag('接力轮询启动失败: ' + String((err && err.message) || err))
      }

      reportStatus({ registered: registered, mode: readMode(), phase: 'apply', clean: CLEAN_VERSION })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})

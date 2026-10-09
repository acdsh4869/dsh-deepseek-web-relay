/**
 * v1.6.0 触发流程集成测试（不依赖浏览器，纯逻辑仿真）。
 *
 * 验证 onUp / onArmKey / onContextMenu 三条入口在各种配置与场景下的行为，
 * 重点覆盖用户投诉的两个场景：
 *   ① 插件市场搜索框 / 过滤标签处划词 → 任何模式下都不冒泡
 *   ② 对话正文普通划词（没按修饰键）→ modifier 模式下不冒泡（旧版会冒）
 */
const { parseHTML } = require('linkedom')

// ── 复制 client.js 的规则表 ──
const NEUTRAL_RULES = [
  ['input, textarea, select, option, optgroup', 'form-control'],
  ['[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]', 'editable'],
  ['[role="textbox"], [role="searchbox"], [role="combobox"], [role="listbox"]', 'aria-input'],
  ['code, pre, kbd, samp, var, [class*="language-"]', 'code'],
  ['[role="code"], .cm-editor, .monaco-editor, [class*="code-block"]', 'code-widget'],
  ['button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"]', 'control'],
  ['label, legend, summary, [role="checkbox"], [role="radio"], [role="switch"]', 'form-label'],
  ['[role="slider"], [role="spinbutton"], [role="progressbar"], meter', 'widget'],
  ['[role="menu"], [role="menubar"], [role="dialog"], [role="alertdialog"], [role="tooltip"]', 'overlay'],
  ['[role="tablist"], [role="toolbar"], [role="navigation"], [role="banner"], [role="contentinfo"]', 'nav'],
  ['nav, aside, header, footer, dialog, details, summary', 'landmark'],
  ['[class*="sidebar"], [class*="Sidebar"], [class*="sidenav"], [class*="nav-list"]', 'sidebar'],
  ['table, thead, tbody, tfoot, tr, td, th, [role="table"], [role="grid"], [role="row"], [role="cell"]', 'table'],
  ['dl, dt, dd', 'description-list'],
  ['[class*="chip"], [class*="Chip"], [class*="badge"], [class*="Badge"],' +
   ' [class*="pill"], [class*="tag-list"], [class*="tagList"], [class*="tags"],' +
   ' [class*="filter-bar"], [class*="filterBar"], [class*="filter-list"],' +
   ' [class*="filter-group"], [class*="facet"]', 'filter-chip'],
  ['svg, canvas, video, img, picture, [role="img"]', 'media'],
]
const CONVERSATION_HINTS = [
  '[class*="message"]', '[class*="Message"]', '[class*="conversation"]', '[class*="Conversation"]',
  '[class*="chat"]', '[class*="Chat"]', '[class*="markdown"]', '[class*="Markdown"]',
  '[class*="prose"]', '[class*="assistant"]', '[class*="bubble"]',
  '[data-role="user"]', '[data-role="assistant"]', '[data-message-id]',
  '[data-testid*="message"]', '[data-testid*="conversation"]',
  'article', '[role="main"]', '[role="log"]',
]

// ── 被测系统（镜像 client.js 的结构）──
function makeSystem(config, document) {
  const state = {
    bubbleShown: false, bubbleText: '', lastValidSelectAt: 0, selCache: null,
    lastSelReject: '', hideTimerFired: 0, modState: { alt: false, ctrl: false, shift: false, meta: false },
  }
  const triggerMode = String(config.bubbleTrigger || 'modifier').trim().toLowerCase()
  const modKey = (() => {
    const m = String(config.bubbleModifier || 'alt').trim().toLowerCase()
    return m === 'control' ? 'ctrl' : (m === 'cmd' ? 'meta' : (['ctrl','shift','meta','alt'].includes(m) ? m : 'alt'))
  })()
  const armWindow = (() => { const n = Number(config.bubbleArmWindow); return Number.isFinite(n) && n >= 500 ? n : 4000 })()

  function classifyZone(el) {
    if (!el || !el.closest) return { zone: 'unknown', why: 'no-anchor' }
    try {
      for (const rule of NEUTRAL_RULES) {
        const hitSelf = el.matches && el.matches(rule[0])
        const hitParent = el.closest(rule[0])
        if (hitSelf || hitParent) return { zone: 'neutral', why: rule[1] }
      }
    } catch (err) { return { zone: 'neutral', why: 'rule-error' } }
    try {
      if (String(config.bubbleScope || '').toLowerCase() === 'conversation') {
        for (const sel of CONVERSATION_HINTS) {
          if ((el.matches && el.matches(sel)) || el.closest(sel)) return { zone: 'chat', why: 'conversation-hint' }
        }
        return { zone: 'neutral', why: 'no-conversation-hint' }
      }
    } catch (err) { return { zone: 'neutral', why: 'scope-error' } }
    return { zone: 'chat', why: 'default-allow' }
  }
  function readSelection(anchorId) {
    const el = document.getElementById(anchorId)
    state.lastSelReject = ''
    if (!el) { state.lastSelReject = 'no-anchor'; return null }
    const zone = classifyZone(el)
    if (el.closest && el.closest('.dsw-bubble')) { state.lastSelReject = 'inside-own-ui'; return null }
    if (zone.zone !== 'chat') { state.lastSelReject = 'zone:' + zone.why; return null }
    return { text: 'TXT(' + anchorId + ')', left: 100, top: 100 }
  }
  /** 镜像 client.js 的 selectionZoneAllowed：当前锚点不在允许区就别走缓存兜底 */
  function selectionZoneAllowed(anchorId) {
    if (!anchorId) return true                       // 选区彻底消失 → 放行缓存
    const el = document.getElementById(anchorId)
    if (!el) return true
    const zone = classifyZone(el)
    if (zone.zone === 'chat') return true
    state.lastSelReject = 'zone:' + zone.why
    return false
  }
  function showNativeBubble(text) { state.bubbleShown = true; state.bubbleText = text }
  function hideNativeBubble() { state.bubbleShown = false }
  function modActive(ev) {
    if (ev) { if (modKey==='alt'&&ev.altKey) return true; if (modKey==='ctrl'&&ev.ctrlKey) return true
              if (modKey==='shift'&&ev.shiftKey) return true; if (modKey==='meta'&&ev.metaKey) return true }
    return Boolean(state.modState[modKey])
  }
  function tryShowBubble(via, anchorId) {
    const live = readSelection(anchorId)
    if (live) { state.lastValidSelectAt = Date.now(); showNativeBubble(live.text); return true }
    if (state.selCache && Date.now() - state.selCache.at < armWindow && selectionZoneAllowed(anchorId)) {
      state.lastValidSelectAt = Date.now(); showNativeBubble(state.selCache.text); return true
    }
    hideNativeBubble(); return false
  }
  const api = {
    state, triggerMode, modKey,
    onUp(ev, anchorId) {
      if (triggerMode === 'off') return
      if (triggerMode === 'contextmenu') return
      if (triggerMode === 'modifier') {
        if (!modActive(ev)) { const p = readSelection(anchorId); if (p) state.lastValidSelectAt = Date.now(); return }
        tryShowBubble('modifier:drag', anchorId); return
      }
      tryShowBubble('select', anchorId)
    },
    onArmKey(ev, anchorId) {
      if (triggerMode !== 'modifier') return
      const key = String(ev.key || '')
      const isModKey = (modKey==='alt'&&key==='Alt')||(modKey==='ctrl'&&key==='Control')||
                       (modKey==='shift'&&key==='Shift')||(modKey==='meta'&&key==='Meta')
      if (!isModKey) return
      if (ev.ctrlKey && modKey !== 'ctrl') return
      if (ev.metaKey && modKey !== 'meta') return
      if (!state.lastValidSelectAt || Date.now() - state.lastValidSelectAt > armWindow) return
      const live = readSelection(anchorId)
      if (!live) return
      state.lastValidSelectAt = 0
      tryShowBubble('modifier:key', anchorId)
    },
    onContextMenu(anchorId) {
      if (triggerMode !== 'contextmenu' && triggerMode !== 'modifier') return
      let text = ''
      const live = readSelection(anchorId)
      if (live) text = live.text
      else if (state.selCache && Date.now() - state.selCache.at < armWindow) text = state.selCache.text
      if (!text) return
      showNativeBubble(text)
    },
    onDown() { state.lastValidSelectAt = 0 },
    onHide() { hideNativeBubble(); state.lastValidSelectAt = 0 },
    // selectionchange 的等价物：只有通过区域闸门才写缓存
    cacheSelection(anchorId) {
      const r = readSelection(anchorId)
      if (!r) { state.selCache = null; return }
      state.selCache = { text: r.text, at: Date.now() }
    },
  }
  return api
}

// ── DOM ──
const { document } = parseHTML(`<!DOCTYPE html><html><body>
  <main role="main"><div class="conversation">
    <div class="message"><p id="chat-text">这是对话正文里的一段话</p></div>
    <pre class="code-block"><code id="code-text">const a = 1</code></pre>
    <div contenteditable="true" id="composer">草稿</div>
  </div></main>
  <section class="market">
    <input type="search" id="mkt-search" />
    <div class="chip-group"><span class="chip" id="mkt-chip">免费</span></div>
    <table><tbody><tr><td id="mkt-cell">描述</td></tr></tbody></table>
    <div class="plugin-desc"><p id="mkt-desc">插件描述</p></div>
  </section>
</body></html>`)

const T = (name, fn) => { try { fn(); console.log('  PASS  ' + name) } catch (e) { fails.push(name); console.log('  FAIL  ' + name + ' → ' + e.message) } }
const eq = (a, b, m) => { if (a !== b) throw new Error((m||'') + ' 期望=' + b + ' 实际=' + a) }
const fails = []

console.log('\n=== 场景1：modifier 模式（v1.6.0 新默认）===')
{
  const s = makeSystem({ bubbleTrigger: 'modifier' }, document)
  s.state.selCache = { text: 'STALE', at: Date.now() } // 预置一个陈旧缓存，验证不会绕过闸门

  T('插件市场搜索框：按住 Alt 划词也不冒泡', () => {
    s.state.bubbleShown = false
    s.onUp({ altKey: true }, 'mkt-search')
    eq(s.state.bubbleShown, false, '不该冒')
    eq(s.state.lastSelReject, 'zone:form-control')
  })
  T('过滤 chip：按住 Alt 划词也不冒泡', () => {
    s.state.bubbleShown = false
    s.onUp({ altKey: true }, 'mkt-chip')
    eq(s.state.bubbleShown, false, '不该冒')
    eq(s.state.lastSelReject, 'zone:filter-chip')
  })
  T('插件卡片描述：按住 Alt 仍会冒（语义上与正文无法区分）', () => {
    // ⚠️ 这是**已知的、被设计上接受的**限制，不是 bug：
    //   插件卡片的描述文字是裸 <div><p>，没有任何语义标记能把它和对话正文区分开
    //   —— 任何纯选择器方案都无法拦下它（除非去匹配 DSH 构建期 class 名，那会随版本失效）。
    //   真正兜住它的是**触发方式的改变**：modifier 模式下用户必须主动按住 Alt，
    //   普通划词（用户截图里的场景）压根不会冒泡。
    //   若要连这一类也拦掉，把 bubbleScope 设成 'conversation'（严格档）即可。
    s.state.bubbleShown = false
    s.onUp({ altKey: true }, 'mkt-desc')
    eq(s.state.bubbleShown, true, '语义上无法区分，交给触发方式兜底')
  })
  T('但普通划词（无修饰键）绝不冒泡 —— 这才是核心诉求', () => {
    s.state.bubbleShown = false
    s.onUp({ altKey: false }, 'mkt-desc')
    eq(s.state.bubbleShown, false, '不该冒')
  })
  T('市场表格：按住 Alt 划词也不冒泡', () => {
    s.state.bubbleShown = false
    s.onUp({ altKey: true }, 'mkt-cell')
    eq(s.state.bubbleShown, false, '不该冒')
  })
  T('正文普通划词（无修饰键）→ 不冒泡（核心诉求）', () => {
    s.state.bubbleShown = false
    s.onUp({ altKey: false }, 'chat-text')
    eq(s.state.bubbleShown, false, '不该冒')
  })
  T('正文按住 Alt 划词 → 冒泡', () => {
    s.state.bubbleShown = false
    s.onUp({ altKey: true }, 'chat-text')
    eq(s.state.bubbleShown, true, '应该冒')
    eq(s.state.bubbleText, 'TXT(chat-text)')
  })
  T('代码块按住 Alt 划词 → 不冒泡', () => {
    s.state.bubbleShown = false
    s.onUp({ altKey: true }, 'code-text')
    eq(s.state.bubbleShown, false, '不该冒')
  })
  T('入口②：先普通划词，再按 Alt → 冒泡', () => {
    const t = makeSystem({ bubbleTrigger: 'modifier' }, document)
    t.onUp({ altKey: false }, 'chat-text')      // 普通划词，不冒，但武装
    eq(t.state.bubbleShown, false)
    t.onArmKey({ key: 'Alt' }, 'chat-text')     // 补按 Alt
    eq(t.state.bubbleShown, true, '应该冒')
  })
  T('入口②：在搜索框划词后按 Alt → 不冒泡', () => {
    const t = makeSystem({ bubbleTrigger: 'modifier' }, document)
    t.onUp({ altKey: false }, 'mkt-search')
    t.onArmKey({ key: 'Alt' }, 'mkt-search')
    eq(t.state.bubbleShown, false, '不该冒')
  })
  T('入口②：mousedown 后（新手势）按 Alt → 不冒泡', () => {
    const t = makeSystem({ bubbleTrigger: 'modifier' }, document)
    t.onUp({ altKey: false }, 'chat-text')
    t.onDown()                                   // 点别处，待命作废
    t.onArmKey({ key: 'Alt' }, 'chat-text')
    eq(t.state.bubbleShown, false, '不该冒')
  })
  T('入口②：待命窗口超时后按 Alt → 不冒泡', () => {
    const t = makeSystem({ bubbleTrigger: 'modifier', bubbleArmWindow: 500 }, document)
    t.onUp({ altKey: false }, 'chat-text')
    t.state.lastValidSelectAt = Date.now() - 600  // 人为超时
    t.onArmKey({ key: 'Alt' }, 'chat-text')
    eq(t.state.bubbleShown, false, '不该冒')
  })
  T('modifier 模式下右键选区 → 冒泡（明确意图）', () => {
    const t = makeSystem({ bubbleTrigger: 'modifier' }, document)
    t.onContextMenu('chat-text')
    eq(t.state.bubbleShown, true, '应该冒')
  })
  T('modifier 模式下右键搜索框 → 不冒泡', () => {
    const t = makeSystem({ bubbleTrigger: 'modifier' }, document)
    t.onContextMenu('mkt-search')
    eq(t.state.bubbleShown, false, '不该冒')
  })
  T('滚动 → 气泡收起且待命作废', () => {
    const t = makeSystem({ bubbleTrigger: 'modifier' }, document)
    t.onUp({ altKey: true }, 'chat-text')
    eq(t.state.bubbleShown, true)
    t.onHide()
    eq(t.state.bubbleShown, false, '应收起')
    eq(t.state.lastValidSelectAt, 0)
  })
}

console.log('\n=== 场景2：缓存不得绕过区域闸门 ===')
{
  const t = makeSystem({ bubbleTrigger: 'modifier' }, document)
  t.cacheSelection('chat-text')            // 正文 → 缓存成功
  eq(t.state.selCache !== null, true, '正文应入缓存')
  t.cacheSelection('mkt-search')           // 搜索框 → 缓存必须被清掉/不写
  eq(t.state.selCache, null, '搜索框不该入缓存')
}

console.log('\n=== 场景3：兼容旧配置 select 模式 ===')
{
  const t = makeSystem({ bubbleTrigger: 'select' }, document)
  t.onUp({}, 'mkt-search')
  eq(t.state.bubbleShown, false, '搜索框仍不该冒（旧配置也受闸门约束）')
  t.onUp({}, 'chat-text')
  eq(t.state.bubbleShown, true, '正文照旧冒泡（保持旧行为）')
}

console.log('\n=== 场景4：off 模式 ===')
{
  const t = makeSystem({ bubbleTrigger: 'off' }, document)
  t.onUp({ altKey: true }, 'chat-text')
  t.onContextMenu('chat-text')
  eq(t.state.bubbleShown, false, 'off 模式一律不冒')
}

console.log('\n=== 场景5：严格档 bubbleScope=conversation ===')
{
  const t = makeSystem({ bubbleTrigger: 'modifier', bubbleScope: 'conversation' }, document)
  t.onUp({ altKey: true }, 'chat-text');  eq(t.state.bubbleShown, true, '正文应放行')
  t.state.bubbleShown = false
  t.onUp({ altKey: true }, 'mkt-desc');   eq(t.state.bubbleShown, false, '无对话特征应拦下')
}

console.log('\n=== 场景6：修饰键可配置 ===')
{
  const t = makeSystem({ bubbleTrigger: 'modifier', bubbleModifier: 'shift' }, document)
  t.onUp({ shiftKey: true }, 'chat-text'); eq(t.state.bubbleShown, true, 'Shift 应生效')
  t.state.bubbleShown = false
  t.onUp({ altKey: true }, 'chat-text');   eq(t.state.bubbleShown, false, 'Alt 不应生效（配的是 shift）')
  t.onArmKey({ key: 'Shift' }, 'chat-text')
  t.onUp({ altKey: false }, 'chat-text')
  t.onArmKey({ key: 'Shift' }, 'chat-text')
  eq(t.state.bubbleShown, true, '入口② 也应按 Shift 生效')
}

console.log('\n' + (fails.length ? '❌ 失败 ' + fails.length + ' 项: ' + fails.join(' / ') : '✅ 全部通过'))
process.exit(fails.length ? 1 : 0)

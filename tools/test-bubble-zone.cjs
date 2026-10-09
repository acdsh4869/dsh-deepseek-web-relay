/**
 * v1.6.0 划词气泡准入逻辑单测。
 *
 * 目的：把 client.js 里的 NEUTRAL_RULES / CONVERSATION_HINTS 两张表和
 * classifyZone 的判定顺序原样搬过来，在真实 DOM（linkedom）上跑一遍，
 * 验证「插件市场搜索框 / 过滤标签 / 设置 / 输入框 / 代码块 一律判 neutral，
 * 而对话正文判 chat」。
 *
 * 关键点：这两张表是本次修复的核心证据，不能只靠肉眼 review 选择器。
 */
const { parseHTML } = require('linkedom')

// ── 与 client.js 完全一致的三张表 ──
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
  '[class*="message"]', '[class*="Message"]',
  '[class*="conversation"]', '[class*="Conversation"]',
  '[class*="chat"]', '[class*="Chat"]',
  '[class*="markdown"]', '[class*="Markdown"]',
  '[class*="prose"]', '[class*="assistant"]', '[class*="bubble"]',
  '[data-role="user"]', '[data-role="assistant"]', '[data-message-id]',
  '[data-testid*="message"]', '[data-testid*="conversation"]',
  'article', '[role="main"]', '[role="log"]',
]
function classifyZone(el, scope) {
  if (!el || !el.closest) return { zone: 'unknown', why: 'no-anchor' }
  try {
    for (const rule of NEUTRAL_RULES) {
      const hitSelf = el.matches && el.matches(rule[0])
      const hitParent = el.closest(rule[0])
      if (hitSelf || hitParent) return { zone: 'neutral', why: rule[1] }
    }
  } catch (err) {
    return { zone: 'neutral', why: 'rule-error' }
  }
  try {
    if (String(scope || '').toLowerCase() === 'conversation') {
      for (const sel of CONVERSATION_HINTS) {
        if ((el.matches && el.matches(sel)) || el.closest(sel)) return { zone: 'chat', why: 'conversation-hint' }
      }
      return { zone: 'neutral', why: 'no-conversation-hint' }
    }
  } catch (err) {
    return { zone: 'neutral', why: 'scope-error' }
  }
  return { zone: 'chat', why: 'default-allow' }
}

// ── 一个尽量贴近 DSH 真实结构的 DOM ──
const { document } = parseHTML(`<!DOCTYPE html><html><body>
  <aside class="sidebar"><nav><ul>
    <li class="nav-list-item"><a href="/s/1">会话一</a></li>
    <li class="nav-list-item"><a href="/s/2">会话二</a></li>
  </ul></nav></aside>

  <main role="main">
    <div class="conversation-list">
      <div class="message message-user"><p id="m-user">帮我看下这段代码有没有问题</p></div>
      <div class="message message-assistant"><div class="markdown-body">
        <p id="m-md">这段代码的边界条件有问题，建议改成这样。</p>
        <pre class="code-block"><code id="m-code">if (x) { return 1 }</code></pre>
      </div></div>
    </div>
    <div class="composer"><div contenteditable="true" id="composer-input">草稿</div></div>
  </main>

  <section class="market-page">
    <div class="market-toolbar">
      <input type="search" placeholder="搜索插件" id="market-search" />
      <input type="text" placeholder="过滤标签" id="market-filter" />
      <button id="market-btn">安装</button>
    </div>
    <div class="filter-tags"><span class="tag" id="tag-1">效率</span><span class="tag" id="tag-2">开发</span></div>
    <div class="chip-group"><span class="chip" id="chip-1">免费</span></div>
    <table id="market-table">
      <tbody><tr><td id="market-cell">插件描述文字</td></tr></tbody>
    </table>
    <div class="plugin-card"><div class="plugin-desc"><p id="card-desc">这是一个插件的详细描述文本。</p></div>
      <a href="/install">立即安装</a></div>
  </section>

  <section class="settings-page">
    <div role="tablist"><button role="tab" id="set-tab">通用</button></div>
    <dl id="set-dl"><dt>主题</dt><dd id="set-dd">深色</dd></dl>
    <nav id="set-nav"><a href="/x">子项</a></nav>
  </section>

  <dialog id="dlg"><p id="dlg-text">对话框里的文字</p></dialog>
  <div role="menu"><div role="menuitem" id="mi">菜单项</div></div>
</body></html>`)

// ── 用例：期望 zone / why ──
const CASES = [
  // 对话正文 → 必须放行
  ['m-user', 'chat', '对话正文（用户消息）'],
  ['m-md', 'chat', '对话正文（markdown）'],
  // 插件市场：用户明确投诉的场景 → 必须全部拦下
  ['market-search', 'neutral', '插件市场搜索框'],
  ['market-filter', 'neutral', '插件市场过滤输入框'],
  ['tag-1', 'neutral', '过滤标签组内的标签'],
  ['tag-2', 'neutral', '过滤标签'],
  ['chip-1', 'neutral', 'chip 标签'],
  ['market-btn', 'neutral', '市场里的按钮'],
  ['market-cell', 'neutral', '市场表格单元格'],
  ['card-desc', 'chat', '⚠️ 插件卡片描述（无 role，待议）'],
  // 设置页
  ['set-tab', 'neutral', '设置页 tab 按钮'],
  ['set-dd', 'neutral', '设置页描述列表 dd'],
  ['set-nav', 'neutral', '设置页 nav'],
  // 其他中性区
  ['composer-input', 'neutral', 'DSH 输入框（Lexical contenteditable）'],
  ['m-code', 'neutral', '代码块'],
  ['dlg-text', 'neutral', '对话框内文字'],
  ['mi', 'neutral', '菜单项'],
]

let pass = 0, fail = 0
const rows = []
for (const [id, want, desc] of CASES) {
  const el = document.getElementById(id)
  if (!el) { console.log('MISSING #' + id); fail++; continue }
  const got = classifyZone(el, 'input-excluded')
  const ok = got.zone === want
  ok ? pass++ : fail++
  rows.push({ 用例: desc, 期望: want, 实际: got.zone, 原因: got.why, 结果: ok ? 'PASS' : 'FAIL' })
}

// conversation 严格档：只认阳性信号
let cPass = 0, cFail = 0
const cCases = [['m-user', 'chat'], ['m-md', 'chat'], ['card-desc', 'neutral'], ['market-search', 'neutral']]
for (const [id, want] of cCases) {
  const got = classifyZone(document.getElementById(id), 'conversation')
  const ok = got.zone === want
  ok ? cPass++ : cFail++
  if (!ok) rows.push({ 用例: '[严格档] ' + id, 期望: want, 实际: got.zone, 原因: got.why, 结果: 'FAIL' })
}

console.table(rows)
console.log('\n默认档 (input-excluded): PASS=' + pass + '  FAIL=' + fail)
console.log('严格档 (conversation):  PASS=' + cPass + '  FAIL=' + cFail)

// 附：print 出「待议」用例，提示是否需要补规则
console.log('\n--- 需要注意的宽松项（默认档判成 chat）---')
for (const id of ['tag-1', 'tag-2', 'card-desc']) {
  console.log('  #' + id + ' →', JSON.stringify(classifyZone(document.getElementById(id), 'input-excluded')))
}

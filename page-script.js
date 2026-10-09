/**
 * page-script.js —— 注入到 chat.deepseek.com 页面里的脚本
 *
 * ⚠️ 这个文件**不是** DSH 插件模块，不要用 require / export。
 * 它由宿主半边（index.js）读取文本后，通过 CDP 注入：
 *   - Page.addScriptToEvaluateOnNewDocument()  → 每次页面加载/刷新都自动运行
 *   - Runtime.evaluate()                       → 对当前已打开的页面立即生效
 *
 * 配置由宿主在注入前拼在脚本前面（window.__DSH_RELAY_CONFIG__）。
 *
 * ── 它做三件事 ─────────────────────────────────────────────
 *   A→B（宿主调用）：window.__dshInjectText(text)
 *       把 DSH 里划词的内容写进网页端底部输入框。
 *
 *   B→A（本脚本自己）：**划词浮现**
 *       鼠标选中任意文字（mouseup）后，在鼠标旁浮出一个小气泡「↪ 传给DSH」；
 *       点它就只抓**选中的那段纯文本**（window.getSelection().toString()），
 *       加上前缀后经 CDP binding `window.__dshRelay(json)` 回传宿主，
 *       由 DSH 客户端写进当前活跃的输入框。
 *
 *   B→A 分支（v1.1.0）：**每条 AI 回复操作栏末尾的「↪ 分支到 DSH」按钮**
 *       点击后抓取当前对话上下文（User / Assistant 逐轮标注），发回宿主；
 *       DSH 客户端自动「新建会话」并把上下文整体填进新输入框。
 *
 *       定位方式（v1.1.0 修订，替换早期"多选择器扫容器"的喷按钮方案）：
 *       **不遍历段落、不碰 .markdown-body** —— 按钮只落在 AI 回复底部的
 *       操作栏（复制 / 点赞 / 点踩 / 分享 / 时间戳那一排）的最后面，
 *       靠"结构识别 + 每回复唯一性检查"保证绝不满屏乱冒。
 *
 *       主题适配（解决"文字发虚 / 深色模式看不见"）：颜色不写死 ——
 *       JS 动态检测背景亮度（站点主题标记 → 祖先背景亮度 → 系统偏好，
 *       三级判据），按 light/dark 切换半透明底 + 深浅文字，并全程抗锯齿；
 *       不用任何滤镜 / 模糊 / 透明度效果。
 *
 * ── 回执与兜底 ─────────────────────────────────────────────
 *   气泡点击后带一个唯一 id 发出去，等 DSH 回执（宿主用 CDP 调
 *   window.__dshRelayAck({id, ok, detail})）。
 *   分支按钮的界面反馈是定时 2s 自动恢复的「已发送」，不依赖回执；
 *   回执/超时只作为**内容兜底**通道（失败时写系统剪贴板 + 弹窗提示）。
 */

;(() => {
  // ─────────────────── A→B 注入入口（供宿主用 CDP 调用）───────────────────
  //
  // 宿主执行：Runtime.evaluate("window.__dshInjectText('文本')")
  // 返回值必须是 JSON 可序列化的，宿主直接读它判断成功/失败。
  //
  // ⚠️ 这一段放在「防重复安装」守卫**之前**，而且每次加载都重新赋值 ——
  //    这样即使窗口一直开着、插件升级了 page-script.js，重新注入也能拿到新逻辑。
  window.__dshInjectText = function (text) {
    // 注入前的二次清洗：DSH 侧选中的内容也会混进 NBSP / 一大堆空行。
    // cleanTransferText 是纯 LF 的；真正写进编辑器时再按需转 \r\n（见下面 toCrlf）。
    const s = cleanTransferText(text)
    if (!s) return { ok: false, detail: '内容为空' }

    /** 只认「看得见」的输入框，避免写到隐藏的模板节点上。 */
    function visible(el) {
      if (!el) return false
      try {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
      } catch (err) {
        return false
      }
    }

    // 🐞 2026-10-01：注入改为**覆盖**模式（与 B→A 的 relayAppendMode:'replace'
    //    默认一致）。原来的追加模式在「上次传的内容还没发走」时把新内容叠在
    //    旧内容后面，输入框越来越乱（10-01 09:34 实测三连发叠到 1729 字）——
    //    那正是「传送不稳定」的观感来源。传送的语义就是「我要发这一段」。

    try {
      // 1) 优先 textarea —— DeepSeek 底部输入框是 textarea
      const areas = Array.from(document.querySelectorAll('textarea')).filter(visible)
      if (areas.length) {
        const el = areas[areas.length - 1] // 取最靠下的那个
        const replaced = Boolean(String(el.value || '').trim())
        const next = s
        // 注入前统一转成 Windows 换行：textarea 的 value setter 会自己归一化，
        // 真正需要 \r\n 的是 contenteditable（见下面），这里保持一致口径。
        const write = toCrlf(next)
        el.focus()
        // React 受控组件：必须走原生 value setter 再派发 input，
        // 直接 el.value = x 会被 React 的下一次渲染覆盖回去。
        const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
        if (desc && desc.set) desc.set.call(el, write)
        else el.value = write
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        try {
          el.selectionStart = el.selectionEnd = write.length
          el.scrollTop = el.scrollHeight
        } catch (err) {
          /* 忽略 */
        }
        return {
          ok: true,
          how: 'textarea',
          replaced: replaced,
          detail:
            '已写入网页端输入框（' +
            next.length +
            ' 字' +
            (replaced ? '，已覆盖原有内容' : '') +
            '）',
        }
      }

      // 2) 兜底：contenteditable 编辑器
      const eds = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(visible)
      if (eds.length) {
        const el = eds[eds.length - 1]
        const replaced = Boolean(String(el.innerText || '').trim())
        const next = s
        // contenteditable 走的是「模拟粘贴 / 写文本」这条路：
        // 必须用 \r\n，否则 Lexical/ProseMirror 里换行会被当成普通空白，
        // 粘出来就是一连串大空格。
        const write = toCrlf(next)
        el.focus()
        const sel = window.getSelection()
        const range = document.createRange()
        // 覆盖语义：全选现有内容且**不折叠** —— insertText 会替换整个选区
        // （旧代码 collapse(false) 折叠到末尾 = 追加，与覆盖语义相悖）
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range)
        // execCommand 能让 Lexical/ProseMirror 这类编辑器收到「正规输入」
        let okExec = false
        try {
          okExec = document.execCommand('insertText', false, write)
        } catch (err) {
          okExec = false
        }
        if (!okExec) {
          // 编辑器不认 execCommand 就退回写 innerText：
          // ⚠️ 必须用 innerText 而不是 textContent —— textContent 里的 \n 会被
          //    HTML 当成普通空白折叠掉，那正是「大空格」的来源之一。
          el.innerText = write
          el.dispatchEvent(
            new InputEvent('input', { bubbles: true, data: next, inputType: 'insertText' }),
          )
        }
        return {
          ok: true,
          how: 'contenteditable',
          replaced: replaced,
          detail: '已写入网页端输入框（contenteditable，覆盖式）',
        }
      }
    } catch (err) {
      return { ok: false, detail: '注入抛错: ' + String((err && err.message) || err) }
    }

    return { ok: false, detail: '没找到网页端的输入框（textarea / contenteditable 都没有）' }
  }

  // 页面刷新后会重新执行，这里防重复安装（只保护下面的划词气泡 + 分支按钮部分）。
  //
  // ⚠️ 守卫是**版本感知**的，不是简单的 true/false：
  //    宿主每次重连都会再 Runtime.evaluate 一次本脚本；而旧版的守卫写的是
  //    `__DSH_RELAY_INSTALLED__ = true`，如果写成 `if (flag) return`，
  //    升级后新脚本会被旧脚本留下的标记挡住、划词气泡永远不出现。
  // v1.1.0 起统一使用发布版本号，废止内部迭代号。
  const SCRIPT_VERSION = 'selection-bubble-v1.1.0-branch'
  if (window.__DSH_RELAY_INSTALLED__ === SCRIPT_VERSION) return
  window.__DSH_RELAY_INSTALLED__ = SCRIPT_VERSION

  // ───────────────────────── 文本清洗（A/B 两端各一份，必须保持一致）─────────────────────────
  //
  // 解决的现场问题：划词带走的内容里混着 不间断空格(U+00A0)、字面量 `&nbsp;`、
  // CRLF、以及一大串连续换行；粘到对方输入框里就变成「特别大且不正常的空格」。
  //
  // ⚠️ 顺序不能换：必须**先把 CRLF/CR 归一成 \n**，再压缩连续换行。
  //    否则 `\r\n\r\n\r\n` 匹配不上 /\n{3,}/，压缩会整个失效。
  //
  // 📌 有意保留的东西：行内的多个普通空格（代码缩进、markdown 对齐）不动 ——
  //    压掉会把代码块排版毁掉。要压的话再说，行为可配。
  const CLEAN_VERSION = 'clean-text-v3-trunc2000'

  /**
   * 互传文本的**硬上限**。定义在清洗函数之前（const 有 TDZ，必须先于任何调用点）。
   * 抓取到文本后立刻截断，保证后面所有处理只面对短文本。
   */
  const TRANSFER_MAX_CHARS = 2000

  /**
   * 安全清洗「互传文本」：与 client.js 里那份 `safeCleanText` **逐行一致**。
   *
   * 🔒 安全约束（与 client.js 同一套）：第一行挡空值；拿到后立刻按上限 slice；
   *    整体 try/catch（失败返回**已截断**的原文）；只用最简单 /g 全局替换，无回溯无循环。
   *
   * @param {string} input 待清洗文本。
   * @param {number} [capOverride] 可选的截断上限（v1.1.0）：分支上下文用
   *   branchMaxChars（默认 5000），比划词的 2000 宽；不传/非法时维持 2000。
   * @returns {string} 清洗后的字符串（已截到上限以内；入参非法返回 ''，绝不抛错）。
   */
  function cleanTransferText(input, capOverride) {
    // 1) 第一行就挡空值：绝不允许 null.replace 冒到页面
    if (!input || typeof input !== 'string') return input || ''
    // 2) 立刻硬截断：超过上限的部分直接切掉，绝不往下传
    const cap = Number(capOverride) > 0 ? Number(capOverride) : TRANSFER_MAX_CHARS
    const cut = input.length > cap ? input.slice(0, cap) : input
    try {
      let t = cut
      // 3) 所有换行风格先归一成 LF（必须最先做）
      t = t.replace(/\r\n/g, '\n')
      t = t.replace(/\r/g, '\n')
      // 4) 会显示成「大空格」的空白字符
      t = t.replace(/\u00A0/g, ' ')
      t = t.replace(/&nbsp;/g, ' ')
      t = t.replace(/[\u200B\uFEFF]/g, '')
      // 5) 行尾空白：行尾的空格/制表符在输入框里就是「看不见的大空档」
      t = t.replace(/[ \t]+\n/g, '\n')
      // 6) 连续 3 个以上换行 → 2 个
      t = t.replace(/\n{3,}/g, '\n\n')
      return t.trim()
    } catch (e) {
      console.error('清洗失败', e)
      return cut
    }
  }

  /** 与 client.js 同名同义，便于两边对照。 */
  const safeCleanText = cleanTransferText

  /** 注入前用：把 LF 换成 Windows 换行（只给「模拟粘贴 / 写 innerText」这类路径用）。 */
  function toCrlf(input) {
    // ⚠️ 必须先把 CRLF 与裸 CR 都归一成 LF，否则 \r\n 里的 \n 会被再插一个 \r，
    //    变成 \r\r\n；而残留的裸 \r 会让下面的 /\n/g 完全匹配不上（换行被吞）。
    return String(input == null ? '' : input)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n/g, '\r\n')
  }

  /**
   * 清掉历史版本插的按钮（v1.4 的每回复按钮、早期 v1.1.0 喷在内容区里的按钮）。
   * 新版按钮只带 `.dsh-branch-btn` 类名（不带 data 属性），不会被这里误删。
   */
  function removeLegacyButtons() {
    try {
      const legacy = document.querySelectorAll(
        '[data-dsh-relay-btn], [data-dsh-branch-wrap], [data-dsh-branch-btn]',
      )
      for (const el of legacy) {
        try {
          el.remove()
        } catch (err) {
          /* 忽略 */
        }
      }
      return legacy.length
    } catch (err) {
      return 0
    }
  }

  const CFG = window.__DSH_RELAY_CONFIG__ || {}
  const BUBBLE_TEXT = CFG.bubbleText || '↪ 传给DSH'
  const MAX_CHARS = Number(CFG.maxChars) || 2000
  /**
   * 发出去后等 DSH 回执的上限；超时就兜底复制。
   *
   * ⚠️ 2026-09-27 从 6000ms 提到 15000ms —— 6000 会把「成功」误判成「失败」：
   * DSH 客户端是**每 1.5 秒轮询一次**接力队列的，一条内容最坏要等 ~1.5s 才被取走，
   * 再叠加写输入框 + 同步 POST 回执 + 渲染，真实往返实测已到 **6.2 秒**，
   * 于是网页端先超时：写系统剪贴板 + 弹「请手动粘贴」，而 DSH 其实**已经写好了**。
   * 15 秒留足余量，仍能在宿主真的没响应时兜底（只是晚一点）。
   */
  const ACK_TIMEOUT_MS = Number(CFG.ackTimeoutMs) > 0 ? Number(CFG.ackTimeoutMs) : 15000
  const LOG = '[dsh-relay]'

  /**
   * 宿主是否支持「回执」（新版宿主才会下发 bubbleText，并且有 /relay-ack 路由）。
   *
   * ⚠️ 必须放在 CFG 之后（const 有 TDZ，放前面会 ReferenceError → 整个脚本挂掉）。
   *
   * 为什么需要这个判断：如果插件升级后**宿主半边还没重启**，回执路由并不存在，
   * 那时每次接力都会在 6 秒后被误判成"注入失败"，弹出"已复制，请手动粘贴"——
   * 明明已经注入成功了。所以旧宿主下退化成"发出去就不管"。
   */
  const HOST_SUPPORTS_ACK = Object.prototype.hasOwnProperty.call(CFG, 'bubbleText')

  // ── 分支到 DSH 新对话的配置（v1.1.0；宿主 buildInjectedSource 白名单下发）──
  /** 每条 AI 回复末尾的分支按钮文字。 */
  const BRANCH_BUTTON_TEXT = CFG.branchButtonText || '↪ 分支到 DSH'
  /** 分支抓取内容的硬上限，超出截断。分支带整段上下文，比划词的 2000 宽。 */
  const BRANCH_MAX_CHARS = Number(CFG.branchMaxChars) > 0 ? Number(CFG.branchMaxChars) : 5000
  /** true = 带截至点击处的全部历史；false = 只带被点击的那条回复。 */
  const BRANCH_INCLUDE_HISTORY = CFG.branchIncludeHistory !== false
  /** 宿主是否支持分支（新宿主才会下发 branchButtonText；旧宿主下不等回执）。 */
  const HOST_SUPPORTS_BRANCH_ACK = Object.prototype.hasOwnProperty.call(CFG, 'branchButtonText')

  /**
   * 内容前缀。宿主 config.relayPrefix 也会带过来；两端保持一致。
   *
   * ⚠️ 前后**都不加换行**：DSH 输入框（Lexical）把每个 `\n` 变成一个**段落**，
   *    前缀若独占一行就会多出一个空段，传几次就"大量空白"。
   *    现在前缀直接贴在正文同一段前面（客户端那边还会再剥一次前缀，双保险）。
   */
  const DEFAULT_PREFIX = '【来自 DeepSeek 网页端上下文，请基于此继续完成后续任务】'
  const PREFIX = (() => {
    const p = typeof CFG.prefix === 'string' ? CFG.prefix : ''
    const raw = p.trim() ? p : DEFAULT_PREFIX
    return raw.replace(/\s+$/, '')
  })()

  /** 回传给宿主。window.__dshRelay 是宿主用 CDP Runtime.addBinding 注册的。 */
  function send(payload) {
    try {
      if (typeof window.__dshRelay !== 'function') return false
      window.__dshRelay(JSON.stringify(payload))
      return true
    } catch (err) {
      return false
    }
  }

  // ───────────────────────── 选区 ─────────────────────────

  /** 当前选中的纯文本（没选中就返回空串）。抓完立刻清洗 + 截断。 */
  function selectionText() {
    try {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return ''
      // 只认 toString()：绝不碰 innerHTML / cloneContents（那会把标签和实体带出来）
      // cleanTransferText 内部：防空值 → 立即截断到 MAX_CHARS → 清洗（失败则原样返回截断后的文本）
      return cleanTransferText(sel.toString())
    } catch (err) {
      return ''
    }
  }

  // ───────────────────────── 气泡 UI ─────────────────────────

  let bubble = null
  let bubbleBtn = null
  let hideTimer = null
  let lastSelection = ''
  let lastPoint = { x: 0, y: 0 }
  /** 已发出、等待回执的那一条：{ id, text, timer } */
  let pending = null

  function ensureBubble() {
    if (bubble && bubble.isConnected) return bubble
    bubble = document.createElement('div')
    bubble.setAttribute('data-dsh-selection-bubble', '1')
    bubble.style.cssText = [
      'position:fixed',
      'z-index:2147483000',
      'display:none',
      'pointer-events:auto',
      'user-select:none',
      '-webkit-user-select:none',
    ].join(';')

    bubbleBtn = document.createElement('button')
    bubbleBtn.type = 'button'
    bubbleBtn.textContent = BUBBLE_TEXT
    bubbleBtn.style.cssText = [
      'font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif',
      'padding:4px 10px',
      'border:1px solid rgba(77,107,254,.5)',
      'border-radius:999px',
      'background:#fff',
      'color:#4D6BFE',
      'box-shadow:0 2px 10px rgba(0,0,0,.16)',
      'cursor:pointer',
      'white-space:nowrap',
    ].join(';')
    // 关键：mousedown 必须阻止默认 —— 否则点气泡的瞬间浏览器会取消选区，
    // 等 click 再读 getSelection() 就什么都拿不到了。
    bubbleBtn.addEventListener(
      'mousedown',
      (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
      },
      true,
    )
    bubbleBtn.addEventListener(
      'click',
      (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        onBubbleClick()
      },
      true,
    )
    bubble.appendChild(bubbleBtn)
    ;(document.body || document.documentElement).appendChild(bubble)
    return bubble
  }

  /** 在鼠标位置旁边浮出气泡。 */
  function showBubble(x, y, text) {
    try {
      ensureBubble()
      bubbleBtn.textContent = BUBBLE_TEXT
      bubbleBtn.disabled = false
      bubble.style.display = 'block'
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
      const w = bubble.offsetWidth || 96
      const h = bubble.offsetHeight || 26
      const vw = window.innerWidth || document.documentElement.clientWidth || 1024
      const vh = window.innerHeight || document.documentElement.clientHeight || 768
      bubble.style.left = Math.max(6, Math.min(Math.round(x + 8), vw - w - 6)) + 'px'
      bubble.style.top = Math.max(6, Math.min(Math.round(y + 12), vh - h - 6)) + 'px'
      lastSelection = text || lastSelection
    } catch (err) {
      /* 画不出来也不能影响页面 */
    }
  }

  /** 收起气泡（点别处 / 滚动 / Esc / 选区没了都会走到这）。 */
  function hideBubble() {
    try {
      if (bubble) {
        bubble.style.display = 'none'
        if (bubbleBtn) {
          bubbleBtn.disabled = false
          bubbleBtn.textContent = BUBBLE_TEXT
        }
      }
    } catch (err) {
      /* 忽略 */
    }
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  // ───────────────────────── 兜底：复制到剪贴板 ─────────────────────────

  /**
   * 注入失败时的兜底：把内容写进系统剪贴板 + 弹窗提示。
   *
   * 两条路一起上：
   *   1) 请宿主用 PowerShell Set-Clipboard 写（最可靠，不受浏览器权限限制）；
   *   2) 页面自己再尽力 copy 一次（有用户手势时通常能成）。
   */
  function fallbackCopy(text, why) {
    let localOk = false
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
      localOk = document.execCommand('copy')
      ta.remove()
    } catch (err) {
      localOk = false
    }
    if (!localOk) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(
            () => {},
            () => {},
          )
          localOk = true
        }
      } catch (err) {
        /* 忽略 */
      }
    }

    // 请宿主用系统剪贴板兜一次，并让 DSH 侧也提示一声
    send({ kind: 'copy', text, detail: why || '' })

    try {
      window.alert('内容已复制，请手动前往 DSH 粘贴')
    } catch (err) {
      /* 忽略 */
    }
    return localOk
  }

  // ───────────────────────── 发送 ─────────────────────────

  /** 把选中的文字加前缀后发给宿主。 */
  function deliver(raw) {
    // 二次清洗（幂等）：上游 selectionText / lastSelection 已经洗过，
    // 这里再洗一遍能兜住任何漏网的 NBSP / 连续空行。
    // cleanTransferText 内部已经先 slice(0, TRANSFER_MAX_CHARS)，所以下面这条分支
    // 只在宿主把 maxChars 配得比 2000 更小时才会命中。
    let body = cleanTransferText(raw)
    if (!body) return
    if (body.length > MAX_CHARS) {
      body = cleanTransferText(body.slice(0, MAX_CHARS)) + '…（已按 ' + MAX_CHARS + ' 字上限截断，避免拖死另一端）'
    }
    // 前缀**直接贴在正文同一段**（不加换行）：Lexical 里换行 = 新段落，
    // 前缀独占一行会多出一个空段，传几次就成"大量空白"。
    const text = PREFIX + body
    const id = 'r' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

    // 通道都没挂上（宿主没连 CDP / relay 关了）→ 直接兜底
    if (typeof window.__dshRelay !== 'function') {
      fallbackCopy(text, '接力通道未连接')
      hideBubble()
      return
    }

    if (pending && pending.timer) clearTimeout(pending.timer)
    pending = HOST_SUPPORTS_ACK
      ? {
          id,
          text,
          timer: setTimeout(() => {
            if (pending && pending.id === id) {
              const t = pending.text
              pending = null
              fallbackCopy(t, '等待 DSH 回执超时')
              hideBubble()
            }
          }, ACK_TIMEOUT_MS),
        }
      : null

    try {
      if (bubbleBtn) {
        // 旧宿主没有回执通道：不要把气泡永远挂在「发送中…」，直接给个已发送 + 自动收起
        bubbleBtn.disabled = true
        bubbleBtn.textContent = HOST_SUPPORTS_ACK ? '发送中…' : '✓ 已发送'
        if (!HOST_SUPPORTS_ACK) hideTimer = setTimeout(hideBubble, 1200)
      }
    } catch (err) {
      /* 忽略 */
    }

    send({
      kind: 'relay',
      id,
      text,
      meta: {
        url: location.href,
        title: (document.title || '').slice(0, 120),
        chars: text.length,
        selected: body.length,
        source: 'selection',
        at: Date.now(),
      },
    })
  }

  function onBubbleClick() {
    // 优先用实时选区；如果点下去的瞬间选区被清了，就用 mouseup 时记下的那份
    const text = selectionText() || lastSelection || ''
    deliver(text)
  }

  /**
   * 宿主回执入口。宿主用 CDP 执行：
   *   window.__dshRelayAck({ id, ok, detail })
   *
   * 划词接力（pending）和分支（branchPending）各自持有唯一 id，
   * 在这里按 id 对号入座 —— 两套流程互不干扰。
   */
  window.__dshRelayAck = function (payload) {
    try {
      const r = typeof payload === 'string' ? JSON.parse(payload) : payload
      if (!r) return

      // ① 划词接力的回执
      if (pending && String(r.id) === String(pending.id)) {
        const p = pending
        pending = null
        if (p.timer) clearTimeout(p.timer)
        if (r.ok === true) {
          try {
            if (bubbleBtn) bubbleBtn.textContent = '✓ 已传给 DSH'
          } catch (err) {
            /* 忽略 */
          }
          hideTimer = setTimeout(hideBubble, 1200)
        } else {
          fallbackCopy(p.text, r.detail || 'DSH 侧没有写入输入框')
          hideBubble()
        }
        return
      }

      // ② 分支请求的回执（v1.1.0）：只清 pending 兜底通道。
      //    按钮的界面反馈（「已发送」2s 自动恢复）不依赖回执。
      if (branchPending && String(r.id) === String(branchPending.id)) {
        const p = branchPending
        branchPending = null
        if (p.timer) clearTimeout(p.timer)
        if (r.ok !== true) {
          // DSH 侧确认失败：兜底复制，内容不丢
          fallbackCopy(p.text, r.detail || 'DSH 侧新建会话失败')
        }
      }
    } catch (err) {
      /* 回执坏了不能影响页面 */
    }
  }

  // ───────────────────────── 事件绑定 ─────────────────────────

  // 划词后浮出气泡（capture 阶段，保证不被站点自己的 mouseup 处理器吞掉）
  document.addEventListener(
    'mouseup',
    (ev) => {
      try {
        // 点的是气泡自己 —— 交给气泡的处理器，不要重算
        if (bubble && bubble.contains(ev.target)) return
        lastPoint = { x: ev.clientX, y: ev.clientY }
        // 等一拍：mouseup 的这一刻选区可能还没定稿
        setTimeout(() => {
          const text = selectionText()
          if (!text) {
            hideBubble()
            return
          }
          lastSelection = text
          showBubble(lastPoint.x, lastPoint.y, text)
        }, 0)
      } catch (err) {
        /* 忽略 */
      }
    },
    true,
  )

  // 点别处 → 收起
  document.addEventListener(
    'mousedown',
    (ev) => {
      try {
        if (bubble && !bubble.contains(ev.target)) hideBubble()
      } catch (err) {
        /* 忽略 */
      }
    },
    true,
  )

  // 滚动 → 收起（capture 才能收到内层滚动容器的 scroll）
  window.addEventListener('scroll', () => hideBubble(), true)

  // Esc → 收起
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) hideBubble()
    },
    true,
  )

  // 选区没了（比如点了空白处把选中取消）→ 收起
  document.addEventListener(
    'selectionchange',
    () => {
      try {
        if (!selectionText()) hideBubble()
      } catch (err) {
        /* 忽略 */
      }
    },
    true,
  )

  // ───────────────── 分支到 DSH 新对话（v1.1.0 · 操作栏版）─────────────────
  //
  // 在每条 AI 回复底部**操作栏**（复制 / 点赞 / 点踩 / 分享 / 时间戳那一排）的
  // 最后面追加「↪ 分支到 DSH」按钮。
  //
  // 🐞 v1.1.0 修订（替换早期"多选择器扫容器"方案）：旧方案认不准回复容器，
  //    按钮喷得到处都是（每个段落 / 代码块后面都冒出来）。新方案**不遍历段落、
  //    不往 .markdown-body 里塞东西**，改用结构识别直接找操作栏：
  //
  //    主路径：以 AI 正文容器（.ds-markdown / .markdown-body，仅作**定位锚**，
  //            绝不做注入目标）为起点，在其**后续兄弟**里找"工具行"——
  //            一行挤着 ≥2 个图标按钮（button 自身几乎无文字、内嵌 svg）的紧凑条。
  //            操作栏天然在正文下方，找到了就是这条回复的；找不到就不注入。
  //
  //    降级路径（正文容器类名全对不上时）：全页扫描图标按钮聚类，
  //            门槛从严（≥3 个图标按钮 + 带时间戳 + 上层有内容痕迹），宁缺毋滥。
  //
  //    唯一性：每个"回复容器"（操作栏向上最近的、含 Markdown 痕迹的祖先）只注入
  //            一个按钮 —— 注入前先查 .dsh-branch-btn，有则跳过；
  //            同一回复出现多个候选栏时取**最底部**那个。MutationObserver 的
  //            重复触发天然被这两道检查挡住。
  //
  // 🎨 主题适配（解决"文字发虚 / 深色模式看不见"）：
  //    · 站点 CSS 变量名不确定，改用 JS 动态判主题：站点主题标记（html/body 的
  //      class / data-theme）→ 从操作栏向上找第一个基本不透明的背景色算亮度 →
  //      系统偏好 prefers-color-scheme，三级判据；
  //    · 浅色主题：深色文字 #374151 + 半透明暗底 rgba(0,0,0,.05)；
  //      深色主题：亮色文字 #E5E7EB + 半透明亮底 rgba(255,255,255,.10)；
  //    · 悬停只改背景色；全程抗锯齿；不用任何滤镜 / 模糊 / 透明度效果；
  //    · 样式只落在专属 <style> 标签的 .dsh-branch-btn 命名空间里，不碰全局 CSS。
  //
  // 🔒 DOM 防御（血泪坑，必须守住）：本段所有 DOM 查询与注入都包在 try/catch 里 ——
  //    站点改版的最坏结果只是「没有分支按钮」，绝不允许把页面搞挂。

  /** 已发出、等待回执的分支请求：{ id, text, timer }（仅作内容兜底通道，不挂 UI 状态）。 */
  let branchPending = null
  let injectTimer = null
  let themeTimer = null
  let branchObserver = null

  /** 扫描防抖：流式输出时 mutation 非常密集，400ms 尾沿去抖。 */
  const BRANCH_DEBOUNCE_MS = 400

  /**
   * AI 回复的「内容痕迹」选择器：只用于判定一个容器是不是 AI 回复、以及找回复边界，
   * **绝不是注入目标**（按钮永远只进操作栏）。
   */
  const MARKDOWN_LANDMARKS =
    '.ds-markdown, .markdown-body, [class*="markdown"], pre, code, blockquote, table'

  /** 用户消息容器的候选选择器（给上下文标注 User 角色用）。 */
  const USER_SELECTORS = [
    '[class*="user-message"]',
    '[class*="userMessage"]',
    '[class*="user-msg"]',
    '[class*="human-message"]',
    '[class*="query"]',
  ]

  /**
   * 分支按钮的全部样式。要点：
   *   · 全部规则都以 .dsh-branch-btn 开头（专属命名空间，不污染全局）；
   *   · 颜色由 data-dsh-theme（JS 亮度检测写入）双主题切换，黑白背景都清晰；
   *   · 悬停只改 background-color；无 filter / backdrop-filter / opacity；
   *   · 抗锯齿 + font-weight:500，专治 12px 小字"发虚"。
   */
  const BRANCH_CSS = [
    '.dsh-branch-btn{',
    '  display:inline-flex;',
    '  align-items:center;',
    '  justify-content:center;',
    '  flex:0 0 auto;',
    '  height:28px;',
    '  padding:0 8px;',
    '  margin-left:4px;',
    '  box-sizing:border-box;',
    '  font-family:inherit;',
    '  font-size:12px;',
    '  font-weight:500;',
    '  line-height:1;',
    '  border:1px solid transparent;',
    '  border-radius:6px;',
    '  cursor:pointer;',
    '  white-space:nowrap;',
    '  user-select:none;',
    '  -webkit-user-select:none;',
    '  -webkit-font-smoothing:antialiased;',
    '  -moz-osx-font-smoothing:grayscale;',
    '  transition:background-color .12s ease;',
    '}',
    '.dsh-branch-btn:disabled{cursor:default;}',
    /* 浅色主题：深色文字 + 半透明暗色底（悬停只加深背景） */
    '.dsh-branch-btn[data-dsh-theme="light"]{',
    '  color:#374151;',
    '  background-color:rgba(0,0,0,0.05);',
    '}',
    '.dsh-branch-btn[data-dsh-theme="light"]:hover:not(:disabled){background-color:rgba(0,0,0,0.10);}',
    /* 深色主题：亮色文字 + 半透明亮色底（悬停只提亮背景） */
    '.dsh-branch-btn[data-dsh-theme="dark"]{',
    '  color:#E5E7EB;',
    '  background-color:rgba(255,255,255,0.10);',
    '}',
    '.dsh-branch-btn[data-dsh-theme="dark"]:hover:not(:disabled){background-color:rgba(255,255,255,0.18);}',
  ].join('\n')

  let branchStyleReady = false

  /** 注入专属 <style>（幂等；失败返回 false，按钮退化为浏览器默认样式也不崩）。 */
  function ensureBranchStyle() {
    if (branchStyleReady) return true
    try {
      if (document.getElementById('dsh-branch-style')) {
        branchStyleReady = true
        return true
      }
      const head = document.head || document.documentElement
      if (!head) return false
      const st = document.createElement('style')
      st.id = 'dsh-branch-style'
      st.textContent = BRANCH_CSS
      head.appendChild(st)
      branchStyleReady = true
      return true
    } catch (err) {
      return false
    }
  }

  /**
   * 判定当前是浅色还是深色主题（给按钮配色用）。
   *
   * 三级判据，逐级兜底：
   *   ① 站点主题标记：html/body 的 data-theme / data-color-scheme / class 里的 dark；
   *   ② 背景亮度：从参照元素（操作栏）向上找第一个**基本不透明**的背景色，
   *      按相对亮度算（< 128 视为深色）—— 这条对自定义主题皮肤最可靠；
   *   ③ 系统偏好 prefers-color-scheme；都没有就按浅色处理。
   *
   * @param {Element} el 参照元素（操作栏 / 按钮）。
   * @returns {'light'|'dark'} 主题。
   */
  function detectTheme(el) {
    try {
      // ① 站点主题标记
      try {
        const root = document.documentElement
        const body = document.body
        const attr = String(
          (root && (root.getAttribute('data-theme') || root.getAttribute('data-color-scheme'))) ||
            (body && (body.getAttribute('data-theme') || body.getAttribute('data-color-scheme'))) ||
            '',
        )
        if (attr.toLowerCase().includes('dark')) return 'dark'
        const cls = String((root && root.className) || '') + ' ' + String((body && body.className) || '')
        if (/(^|\s)(dark|theme-dark|dark-theme)(\s|$)/.test(cls)) return 'dark'
      } catch (err) {
        /* 忽略 */
      }
      // ② 背景亮度：半透明背景跳过，找到第一层基本不透明的为止
      let node = el && el.nodeType === 1 ? el : null
      for (let i = 0; i < 8 && node && node.nodeType === 1; i++) {
        try {
          const bg = String(getComputedStyle(node).backgroundColor || '')
          const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(bg)
          if (m) {
            const a = m[4] === undefined ? 1 : Number(m[4])
            if (a >= 0.6) {
              const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])
              return lum < 128 ? 'dark' : 'light'
            }
          }
        } catch (err) {
          /* 忽略 */
        }
        node = node.parentElement
      }
      // ③ 系统偏好
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

  /** 刷新已注入按钮的主题标记（站点切换深浅色 / 换皮肤时用）。 */
  function refreshBranchThemes() {
    try {
      const btns = document.querySelectorAll('.dsh-branch-btn')
      for (const b of btns) {
        try {
          const t = detectTheme(b)
          if (b.getAttribute('data-dsh-theme') !== t) b.setAttribute('data-dsh-theme', t)
        } catch (err) {
          /* 单个失败不影响其余 */
        }
      }
    } catch (err) {
      /* 忽略 */
    }
  }

  /** 元素看得见吗（一个 getBoundingClientRect 搞定，不动 getComputedStyle）。 */
  function isVisible(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    } catch (err) {
      return false
    }
  }

  /** 元素在我们自己注入的 UI 里吗（气泡 / 分支按钮都别算回复内容）。 */
  function isInsideOurUi(el) {
    try {
      return Boolean(
        el &&
          el.closest &&
          el.closest(
            '[data-dsh-selection-bubble], .dsh-branch-btn, [data-dsh-branch-wrap], [data-dsh-branch-btn]',
          ),
      )
    } catch (err) {
      return false
    }
  }

  /** DOM 顺序比较器（document position，稳）。 */
  function docOrder(a, b) {
    try {
      if (a === b) return 0
      const pos = a.compareDocumentPosition(b)
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1 // a 在 b 前
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1 // a 在 b 后
    } catch (err) {
      /* 忽略 */
    }
    return 0
  }

  /** 同组元素里若有嵌套（A 包含 B），丢掉外层 A、保留最内层 B。 */
  function keepInnermost(els) {
    return els.filter((a) => !els.some((b) => b !== a && a.contains(b)))
  }

  /**
   * 是「图标按钮」吗：button（或 role=button）、自身几乎没有文字、通常内嵌 svg。
   * 操作栏里的复制 / 点赞 / 点踩 / 分享都是这类；带文字的功能按钮不算。
   */
  function isIconButton(el) {
    try {
      if (!el || el.nodeType !== 1) return false
      if (el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') return false
      if (el.closest('.dsh-branch-btn')) return false // 我们自己的按钮不参与计数
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0 || r.height > 40) return false
      const own = String(el.textContent || '').trim()
      if (own.length > 2) return false
      return el.querySelector('svg, img') !== null || own.length === 0
    } catch (err) {
      return false
    }
  }

  /** 数一个容器（浅层：子 → 孙 → 曾孙）里的图标按钮个数。 */
  function countIconButtons(el) {
    let n = 0
    try {
      const walk = (node, depth) => {
        for (let i = 0; i < node.children.length; i++) {
          const c = node.children[i]
          if (isIconButton(c)) n++
          else if (depth < 2) walk(c, depth + 1)
        }
      }
      walk(el, 0)
    } catch (err) {
      /* 忽略 */
    }
    return n
  }

  /** 栏内带时间戳吗（操作栏的强特征：14:32 / 今天 / 昨天）。 */
  function hasTimeText(el) {
    try {
      const t = String(el.textContent || '')
      return /\d{1,2}:\d{2}/.test(t) || /今天|昨天|星期|周[一二三四五六日]/.test(t)
    } catch (err) {
      return false
    }
  }

  /**
   * 在输入区（composer）里吗：往上 2 层内出现 textarea / contenteditable
   * 就认定是输入框的工具行（附件 / 发送那一排），绝不住里注入。
   */
  function nearInputArea(el) {
    try {
      let p = el
      for (let i = 0; i < 2; i++) {
        p = p.parentElement
        if (!p) return false
        if (p.querySelector('textarea, [contenteditable="true"]')) return true
      }
      return false
    } catch (err) {
      return false
    }
  }

  /**
   * 是「工具行」吗：紧凑横条 + 图标按钮达到要求数 + 不在输入区 / 表头 / 顶栏。
   *
   * @param {Element} el 候选元素。
   * @param {number} [minIcons=2] 图标按钮下限（降级扫描时提到 3，宁缺毋滥）。
   * @returns {boolean} 是否工具行。
   */
  function isToolbarRow(el, minIcons) {
    try {
      if (!el || el.nodeType !== 1) return false
      if (el.tagName === 'BUTTON') return false // 工具栏是容器，不是按钮本身
      if (!isVisible(el)) return false
      if (isInsideOurUi(el)) return false
      if (nearInputArea(el)) return false
      if (el.closest('header, nav, form')) return false
      const r = el.getBoundingClientRect()
      if (r.height <= 0 || r.height > 48 || r.width < 40) return false
      const txt = String(el.textContent || '').trim()
      if (txt.length > 40) return false // 时间戳 + 零星短标签，大段文字的不算
      const cs = getComputedStyle(el)
      if (cs.position === 'fixed' || cs.position === 'sticky') return false
      return countIconButtons(el) >= (minIcons || 2)
    } catch (err) {
      return false
    }
  }

  /** 在一个元素（自身或其子孙）里找第一个工具行。 */
  function toolbarIn(el) {
    try {
      if (!el || el.nodeType !== 1) return null
      if (isToolbarRow(el)) return el
      const rows = el.querySelectorAll('div, span, footer')
      for (const r of rows) {
        if (isToolbarRow(r)) return r
      }
    } catch (err) {
      /* 忽略 */
    }
    return null
  }

  /**
   * 以 AI 正文容器为锚，找它**下方**的操作栏。
   * 只看后续兄弟（操作栏在正文下方）：先在正文的兄弟里找，找不到再上移一层
   * 找正文容器的兄弟 —— 两层足够覆盖"正文 → 页脚 → 操作栏"的结构，
   * 再往上就可能串到**下一条消息**，宁可找不到也不冒错位按钮。
   *
   * @param {Element} landmark AI 正文容器（仅作定位锚）。
   * @returns {Element|null} 操作栏元素。
   */
  function findActionBarBelow(landmark) {
    try {
      let base = landmark
      for (let level = 0; level < 2 && base && base.parentElement; level++) {
        const parent = base.parentElement
        let sib = base.nextElementSibling
        let scanned = 0
        while (sib && scanned < 5) {
          const bar = toolbarIn(sib)
          if (bar) return bar
          sib = sib.nextElementSibling
          scanned++
        }
        base = parent
      }
    } catch (err) {
      /* 忽略 */
    }
    return null
  }

  /** 找页面上的 AI 正文容器（定位锚）：精确类名优先，全无命中再用宽松匹配兜底。 */
  function pickLandmarks() {
    try {
      let out = []
      const collect = (sel) => {
        const hits = []
        try {
          for (const el of document.querySelectorAll(sel)) {
            try {
              if (!isVisible(el) || isInsideOurUi(el)) continue
              if (String(el.textContent || '').trim().length === 0) continue
              hits.push(el)
            } catch (err) {
              /* 单个失败不影响其余 */
            }
          }
        } catch (err) {
          /* 选择器非法就当空 */
        }
        return hits
      }
      out = collect('.ds-markdown, .markdown-body')
      if (!out.length) out = collect('[class*="markdown"]')
      return keepInnermost(out)
    } catch (err) {
      return []
    }
  }

  /**
   * 操作栏 → 回复容器：向上（≤4 层）找第一个包含 Markdown 痕迹的祖先。
   * 找不到返回 null —— 意味着这不是 AI 回复的操作栏（用户消息 / 输入区 / 顶栏），
   * 调用方据此跳过。这也是"每条回复只注一个按钮"的去重范围。
   *
   * @param {Element} bar 操作栏（或它里面的任意节点，如我们的按钮）。
   * @returns {Element|null} 回复容器。
   */
  function replyScopeOf(bar) {
    try {
      let p = bar
      for (let i = 0; i < 4; i++) {
        p = p.parentElement
        if (!p || p === document.body || p === document.documentElement) break
        try {
          if (p.querySelector(MARKDOWN_LANDMARKS)) return p
        } catch (err) {
          /* 忽略 */
        }
      }
    } catch (err) {
      /* 忽略 */
    }
    return null
  }

  /**
   * 降级路径：全页扫描图标按钮聚类出的工具行（按文档序返回）。
   * 只在"一个正文锚都找不到"时使用，且调用方还会叠加从严条件。
   */
  function scanToolbarCandidates() {
    const out = []
    try {
      const counts = new Map()
      const btns = document.querySelectorAll('button, [role="button"]')
      for (const b of btns) {
        try {
          if (!isIconButton(b)) continue
          const p = b.parentElement
          if (!p) continue
          counts.set(p, (counts.get(p) || 0) + 1)
          const g = p.parentElement
          if (g) counts.set(g, (counts.get(g) || 0) + 1)
        } catch (err) {
          /* 单个失败不影响其余 */
        }
      }
      for (const el of counts.keys()) {
        try {
          if (isToolbarRow(el, 2)) out.push(el)
        } catch (err) {
          /* 忽略 */
        }
      }
      out.sort(docOrder)
    } catch (err) {
      /* 忽略 */
    }
    return out
  }

  /** landmark → 已配对操作栏 的记忆（防每轮全量重扫；栏被重建时自动失效）。 */
  const landmarkBarMemo = new WeakMap()

  /** 造一个分支按钮（样式全在专属 <style> 里，这里只挂主题标记和事件）。 */
  function makeBranchButton(theme) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'dsh-branch-btn'
    btn.setAttribute('data-dsh-theme', theme === 'dark' ? 'dark' : 'light')
    btn.textContent = BRANCH_BUTTON_TEXT
    btn.title = '把这段对话（含上下文）带进 DSH 的新会话'
    // 🔒 绝不让点击冒泡到 DeepSeek 自己的逻辑（复制 / 重新生成 / 点赞都在旁边）；
    //    mousedown 也拦，避免抢走焦点 / 清掉选区。
    btn.addEventListener(
      'mousedown',
      (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
      },
      true,
    )
    btn.addEventListener(
      'click',
      (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        onBranchClick(btn)
      },
      true,
    )
    return btn
  }

  /**
   * 往操作栏末尾注入一个分支按钮（幂等：栏里 / 回复容器里已有则跳过）。
   *
   * @param {Element} bar 操作栏。
   * @returns {boolean} 是否真正注入了。
   */
  function injectBranchButton(bar) {
    try {
      if (!bar || !bar.appendChild) return false
      if (bar.querySelector('.dsh-branch-btn')) return false
      const scope = replyScopeOf(bar)
      if (scope && scope.querySelector('.dsh-branch-btn')) return false
      bar.appendChild(makeBranchButton(detectTheme(bar)))
      return true
    } catch (err) {
      return false
    }
  }

  /**
   * 扫一遍页面补分支按钮（每次 MutationObserver 触发后防抖进入这里）。
   *
   * 主路径：正文锚 → 下方操作栏 → 注入；
   * 降级路径（一个锚都没有时）：图标按钮聚类 + 时间戳 + 内容痕迹，从严把关。
   * 任何异常都吞掉 —— 最坏就是这一轮没补上按钮。
   */
  function injectBranchButtons() {
    try {
      ensureBranchStyle()
      const landmarks = pickLandmarks()
      let injected = 0

      // ── 主路径 ──
      for (const lm of landmarks) {
        try {
          // 快路径：这条回复的操作栏已配对且按钮还在 → 跳过（防 observer 重复注入）
          let bar = landmarkBarMemo.get(lm)
          if (bar) {
            if (bar.isConnected && bar.querySelector('.dsh-branch-btn')) continue
            landmarkBarMemo.delete(lm) // 栏被重建了，重新找
          }
          bar = findActionBarBelow(lm)
          if (bar) {
            landmarkBarMemo.set(lm, bar)
            if (injectBranchButton(bar)) injected++
          }
        } catch (err) {
          /* 单条失败不影响其余 */
        }
      }

      // ── 降级路径：正文锚全失手（站点改版换了容器类名）──
      //    门槛从严：≥3 个图标按钮 + 带时间戳 + 上层有内容痕迹；
      //    倒序取每个回复**最底部**的候选栏，宁缺毋滥。
      if (injected === 0 && landmarks.length === 0) {
        const bars = scanToolbarCandidates()
        bars.reverse()
        for (const bar of bars) {
          try {
            if (!hasTimeText(bar)) continue
            if (countIconButtons(bar) < 3) continue
            const scope = replyScopeOf(bar)
            if (!scope) continue
            if (scope.querySelector('.dsh-branch-btn')) continue
            if (injectBranchButton(bar)) injected++
          } catch (err) {
            /* 忽略 */
          }
        }
      }
    } catch (err) {
      /* 网页改版也不允许崩：最坏就是没有分支按钮 */
    }
  }

  /** MutationObserver 回调的去抖（尾沿）：页面频繁渲染时一轮 mutation 只扫一次。 */
  function scheduleInject() {
    if (injectTimer) return
    injectTimer = setTimeout(() => {
      injectTimer = null
      try {
        injectBranchButtons()
      } catch (err) {
        /* 忽略 */
      }
    }, BRANCH_DEBOUNCE_MS)
  }

  /** 主题切换的去抖：只刷新已有按钮的 data-dsh-theme，不做全量扫描。 */
  function scheduleThemeRefresh() {
    if (themeTimer) return
    themeTimer = setTimeout(() => {
      themeTimer = null
      try {
        refreshBranchThemes()
      } catch (err) {
        /* 忽略 */
      }
    }, 300)
  }

  // ───────────────────── 分支上下文提取 ─────────────────────

  /**
   * 读一个容器的正文。⚠️ 先把我们注入的按钮临时 display:none ——
   * innerText 只返回「正在渲染」的文本，藏起来的子树不会被带出来
   * （比 cloneNode 干净：克隆节点没有布局，innerText 会退化成 textContent，
   *   段落边界全丢。）
   */
  function extractText(el) {
    if (!el) return ''
    try {
      const hidden = []
      try {
        for (const mine of el.querySelectorAll(
          '.dsh-branch-btn, [data-dsh-branch-wrap], [data-dsh-branch-btn]',
        )) {
          if (mine.style.display !== 'none') {
            mine.style.display = 'none'
            hidden.push(mine)
          }
        }
      } catch (err) {
        /* 隐藏失败就原样读（最多多带一个按钮文字） */
      }
      let text = ''
      try {
        text = String(el.innerText || '')
      } catch (err) {
        text = String(el.textContent || '')
      }
      for (const mine of hidden) {
        try {
          mine.style.display = ''
        } catch (err) {
          /* 恢复失败也不影响 */
        }
      }
      // 只做归一（NBSP / 连续空行等），截断交给 prepareBranchText
      return cleanTransferText(text, 200000).trim()
    } catch (err) {
      return ''
    }
  }

  /** 抓用户消息容器（窄选择器 + 过滤，抓不到就宁缺毋滥）。 */
  function pickUserElements() {
    const out = []
    const seen = new Set()
    try {
      for (const sel of USER_SELECTORS) {
        let list = []
        try {
          list = Array.from(document.querySelectorAll(sel))
        } catch (err) {
          continue
        }
        for (const el of list) {
          try {
            if (!el || seen.has(el)) continue
            if (!isVisible(el) || isInsideOurUi(el)) continue
            if (el.closest('header, nav, form')) continue // 搜索框之类的不是用户消息
            const t = String(el.textContent || '').trim()
            if (t.length < 2 || t.length > 3000) continue
            if (el.querySelector(MARKDOWN_LANDMARKS)) continue // 含 Markdown 痕迹的不是用户气泡
            seen.add(el)
            out.push(el)
          } catch (err) {
            /* 单个失败不影响其余 */
          }
        }
      }
    } catch (err) {
      /* 忽略 */
    }
    return keepInnermost(out)
  }

  /**
   * 收集对话轮次（含角色），截至分支点。
   *
   * 策略（逐级降级，绝不抛错）：
   *   ① 用户消息容器 + AI 正文容器都有命中 → 按 DOM 顺序合并（结构最准）；
   *   ② 用户容器抓不到 → 只带 AI 回复（角色标注不完整但内容干净）；
   *   ③ 全套失手 → 主聊天区整块当一条 assistant（最后的兜底）。
   *
   * @param {Element|null} clicked 分支点（被点击按钮所在的回复容器），null 表示不截断。
   * @param {boolean} includeHistory true 带截至分支点的全部轮次；false 只带分支点那一条。
   * @returns {{role:string, text:string}[]} 轮次列表。
   */
  function collectTurns(clicked, includeHistory) {
    let picked = []
    try {
      const userEls = pickUserElements()
      const asstEls = pickLandmarks()
      picked = [
        ...userEls.map((el) => ({ el: el, role: 'user' })),
        ...asstEls.map((el) => ({ el: el, role: 'assistant' })),
      ].sort((a, b) => docOrder(a.el, b.el))

      // 截断到分支点：它出现在第几轮，就带到第几轮（该轮之前的用户提问按文档序天然包含）
      if (clicked) {
        let idx = -1
        for (let i = 0; i < picked.length; i++) {
          const el = picked[i].el
          if (el === clicked || el.contains(clicked) || clicked.contains(el)) idx = Math.max(idx, i)
        }
        if (idx >= 0) picked = picked.slice(0, idx + 1)
      }

      // 只要分支点那一条（includeHistory = false）
      if (!includeHistory) {
        let hit = null
        for (const t of picked) {
          if (clicked && (t.el === clicked || t.el.contains(clicked) || clicked.contains(t.el))) {
            hit = t
          }
        }
        picked = hit ? [hit] : picked.slice(-1)
      }
    } catch (err) {
      picked = []
    }

    const turns = []
    try {
      for (const t of picked) {
        const text = extractText(t.el)
        if (text) turns.push({ role: t.role, text: text })
      }
      if (!turns.length) {
        const root = findFallbackContainer()
        const text = root ? extractText(root) : ''
        if (text) turns.push({ role: 'assistant', text: text })
      }
    } catch (err) {
      /* 忽略 */
    }
    return turns
  }

  /** 兜底容器：整套结构识别都失手时，取主聊天区（整块当一条回复）。 */
  function findFallbackContainer() {
    try {
      const roots = Array.from(
        document.querySelectorAll('main, [class*="chat"], [class*="conversation"]'),
      ).filter((el) => isVisible(el) && String(el.textContent || '').trim().length > 100)
      return roots.length ? roots[roots.length - 1] : null
    } catch (err) {
      return null
    }
  }

  /** 格式化为带清晰角色标识的 Markdown 文本：`User: xxx \n\n Assistant: xxx`。 */
  function formatBranchText(turns) {
    const parts = []
    for (const t of turns) {
      parts.push((t.role === 'user' ? 'User' : 'Assistant') + ': ' + t.text)
    }
    return parts.join('\n\n')
  }

  /**
   * 分支正文的最终整形：归一 + 按 branchMaxChars 硬截断（超出部分直接切掉，
   * 留一点余量放截断标记，保证总长不超上限）。
   */
  function prepareBranchText(raw) {
    try {
      let t = cleanTransferText(raw, 200000)
      if (!t) return ''
      if (t.length > BRANCH_MAX_CHARS) {
        t =
          t.slice(0, Math.max(1, BRANCH_MAX_CHARS - 24)) +
          '…（已按 ' +
          BRANCH_MAX_CHARS +
          ' 字上限截断）'
      }
      return t
    } catch (err) {
      return String(raw || '').slice(0, BRANCH_MAX_CHARS)
    }
  }

  /**
   * 提取当前对话上下文（分支按钮点击时调用）。
   *
   * @param {Element} fromBar 被点击的按钮（从它向上定位所在回复 = 分支点）。
   * @returns {string} 格式化后的上下文（不带前缀、已按 branchMaxChars 截断）；抓不到返回 ''。
   */
  function extractContext(fromBar) {
    try {
      const scope = replyScopeOf(fromBar)
      const turns = collectTurns(scope, BRANCH_INCLUDE_HISTORY)
      const body = prepareBranchText(formatBranchText(turns))
      if (!body) return ''
      // 🐞 2026-09-30 用户反馈：分支是**全新会话**，上下文本身就是 User:/Assistant:
      //    逐轮标注的完整对话，再加「来自 DeepSeek 网页端上下文…」前缀纯属画蛇添足。
      //    前缀只保留给划词接力（relay）那条路用（502 行 text = PREFIX + body）。
      return body
    } catch (err) {
      return ''
    }
  }

  // ───────────────────── 分支按钮点击 ─────────────────────

  /**
   * 分支按钮点击：提取上下文 → 发宿主 → 「已发送」+ 禁用，2 秒后恢复。
   * 回执（__dshRelayAck）只作为内容兜底通道，不影响按钮的定时恢复。
   */
  function onBranchClick(btn) {
    try {
      if (btn.disabled) return
      const text = extractContext(btn)

      if (!text) {
        try {
          btn.textContent = '↪ 没抓到内容'
        } catch (err) {
          /* 忽略 */
        }
        setTimeout(() => {
          try {
            btn.textContent = BRANCH_BUTTON_TEXT
          } catch (err) {
            /* 忽略 */
          }
        }, 1500)
        return
      }

      const id = 'b' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

      if (typeof window.__dshRelay !== 'function') {
        // 通道没挂上（宿主没连 CDP / relay 关了）→ 直接兜底复制，内容不丢
        fallbackCopy(text, '接力通道未连接')
      } else {
        // 回执兜底通道：DSH 确认失败 / 超时 → 网页端再写一次系统剪贴板
        if (branchPending && branchPending.timer) clearTimeout(branchPending.timer)
        branchPending = HOST_SUPPORTS_BRANCH_ACK
          ? {
              id: id,
              text: text,
              timer: setTimeout(() => {
              if (branchPending && branchPending.id === id) {
                const p = branchPending
                branchPending = null
                fallbackCopy(p.text, '等待 DSH 回执超时（CDP 通道可能已断开）')
              }
            }, ACK_TIMEOUT_MS),
            }
          : null

        const sent = send({
          kind: 'branch',
          id: id,
          text: text,
          meta: {
            url: location.href,
            title: (document.title || '').slice(0, 120),
            chars: text.length,
            includeHistory: BRANCH_INCLUDE_HISTORY,
            source: 'branch',
            at: Date.now(),
          },
        })
        // 🔎 发送校验（v1.1.0 修复「点了没反应」）：send 返回 false 说明 binding
        //    不在或调用抛错（CDP 通道异常）—— 立刻兜底复制 + 明确反馈，
        //    不用等 15 秒回执超时才发现消息根本没送出去。
        if (!sent) {
          if (branchPending && branchPending.id === id) {
            if (branchPending.timer) clearTimeout(branchPending.timer)
            branchPending = null
          }
          fallbackCopy(text, '发送到宿主失败（CDP 通道未连接）')
        }
      }

      // 界面反馈（按需求规定）：已发送 + 禁用，2 秒后恢复原状
      btn.disabled = true
      btn.textContent = '已发送'
      setTimeout(() => {
        try {
          btn.disabled = false
          btn.textContent = BRANCH_BUTTON_TEXT
        } catch (err) {
          /* 按钮已被重建的话就不用管 */
        }
      }, 2000)
    } catch (err) {
      // 任何一步失手都把按钮恢复到可点状态
      try {
        btn.disabled = false
        btn.textContent = BRANCH_BUTTON_TEXT
      } catch (err2) {
        /* 忽略 */
      }
    }
  }

  // ───────────────────── 启动 ─────────────────────

  /**
   * 启动分支功能：注入样式 + 首轮补按钮 + 挂观察器。
   *
   * 观察器分工：
   *   · body 子树 childList（新回复渲染 / 操作栏出现）→ 防抖补按钮；
   *   · html / body 的 class / style / data-theme 变化（切深浅色 / 换皮肤）→
   *     防抖刷新已有按钮的主题标记；
   *   · 观察器挂不上时退化为 3 秒周期兜底扫描。
   * 新文档注入可能在 body 出现之前跑，先等 body（带上限，别死等）。
   */
  function startBranchFeature() {
    try {
      if (!document.body) {
        let tries = 0
        const waitBody = setInterval(() => {
          tries++
          if (document.body || tries >= 100) {
            clearInterval(waitBody)
            if (document.body) startBranchFeature()
          }
        }, 300)
        return
      }

      ensureBranchStyle()
      injectBranchButtons()
      refreshBranchThemes()

      let observerOk = false
      try {
        branchObserver = new MutationObserver(scheduleInject)
        branchObserver.observe(document.body, { childList: true, subtree: true })
        observerOk = true
      } catch (err) {
        branchObserver = null
      }

      // 主题切换：盯 html / body 的属性变化（不少站点切主题就是改这两处）
      try {
        const themeObs = new MutationObserver(scheduleThemeRefresh)
        themeObs.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
        })
        themeObs.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'],
        })
      } catch (err) {
        /* 挂不上就靠周期扫描里的 refreshBranchThemes 兜底 */
      }

      // 观察器挂不上 / 漏网情形的兜底：周期扫描（顺带刷新主题）
      if (!observerOk) {
        setInterval(() => {
          try {
            injectBranchButtons()
            refreshBranchThemes()
          } catch (err) {
            /* 忽略 */
          }
        }, 3000)
      }
    } catch (err) {
      /* 启动失败 = 没有分支按钮，不影响其他功能 */
    }
  }

  startBranchFeature()

  send({
    kind: 'ready',
    url: location.href,
    log: LOG,
    mode: 'selection-bubble+branch',
    scriptVersion: SCRIPT_VERSION,
    clean: CLEAN_VERSION,
    bubble: BUBBLE_TEXT,
    prefix: PREFIX.trim(),
    branch: {
      button: BRANCH_BUTTON_TEXT,
      maxChars: BRANCH_MAX_CHARS,
      includeHistory: BRANCH_INCLUDE_HISTORY,
      target: 'action-bar',
    },
    legacyRemoved: removeLegacyButtons(),
  })

  // 升级残留清理：只在刚装上的一分钟内盯着（旧版 observer 会复活按钮）
  let cleanupTicks = 0
  const cleanupTimer = setInterval(() => {
    cleanupTicks++
    const n = removeLegacyButtons()
    if (n > 0) send({ kind: 'ready', url: location.href, note: 'removed-legacy-buttons', n: n })
    if (cleanupTicks >= 30) clearInterval(cleanupTimer)
  }, 2000)
})()

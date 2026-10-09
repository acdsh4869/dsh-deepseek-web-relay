// dsh-deepseek-web-relay v1.5.0 气泡交互自测（CDP 驱动无头 Chrome 打开 DSH 网页）
// 验证三件事：
//  A. 插件在页面里加载（window.__dswBubble 存在）
//  B. 光环命中：点击气泡中心 → fire → 发送（XHR 打桩，不真实注入）
//  C. 环外按下销毁气泡、环内按下不销毁
const { spawn } = require('child_process')
const http = require('http')
const WebSocket = require('ws')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9777
const TOKEN = process.argv[2]
if (!TOKEN) {
  console.error('用法: node selftest-bubble.js <dshToken>')
  process.exit(2)
}
const URL_ = `http://127.0.0.1:3080/?token=${TOKEN}&dshDesktop=1`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(b))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

async function main() {
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=' + process.env.TEMP + '\\dsw-selftest-profile',
    '--no-first-run',
    '--window-size=1280,900',
    URL_,
  ], { stdio: 'ignore' })
  chrome.on('error', (e) => console.error('chrome spawn error:', e.message))

  let targets = null
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    try {
      targets = await getJson('/json/list')
      if (targets && targets.some((t) => t.type === 'page' && t.url.includes('127.0.0.1:3080'))) break
    } catch (e) {
      /* 还没起来 */
    }
  }
  if (!targets) throw new Error('Chrome CDP 未就绪')
  const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:3080'))
  console.log('页面:', page.url.slice(0, 80))

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => {
    ws.on('open', res)
    ws.on('error', rej)
  })
  let seq = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const m = JSON.parse(raw)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const send = (method, params) =>
    new Promise((res) => {
      const id = ++seq
      pending.set(id, res)
      ws.send(JSON.stringify({ id, method, params: params || {} }))
    })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text }
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  // 无头页面可能未激活，先启用
  await send('Runtime.enable')

  await sleep(4000) // 等插件注入
  const href = await evalJs('location.href')
  console.log('href:', String(href).slice(0, 90))
  const has = await evalJs('typeof window.__dswBubble')
  console.log('__dswBubble:', has)
  if (has !== 'object') {
    console.log('RESULT: FAIL — 外部 Chrome 里插件未注入（DSH 可能只给内嵌 WebView 注插件）')
    console.log('title:', await evalJs('document.title'))
    chrome.kill()
    process.exit(1)
  }

  // 打桩 XHR：捕获 /inject 请求体，不真正发送；其余（/status）照常假成功
  await evalJs(`(function(){
    if (window.__xhrStubbed) return 'already'
    window.__xhrStubbed = true
    window.__realXHR = window.XMLHttpRequest
    window.__injectCalls = []
    function FakeXHR(){ this.headers={}; this.readyState=0 }
    FakeXHR.prototype.open=function(m,u){ this.method=m; this.url=u; this.readyState=1 }
    FakeXHR.prototype.setRequestHeader=function(k,v){ this.headers[k]=v }
    FakeXHR.prototype.send=function(body){
      const xhr=this
      setTimeout(function(){
        if (String(xhr.url).indexOf('/inject')>=0) window.__injectCalls.push(String(body||''))
        xhr.status=200; xhr.readyState=4
        xhr.responseText=JSON.stringify({ok:true,how:'stub',detail:'自测桩'})
        if (xhr.onload) xhr.onload()
        if (xhr.onreadystatechange) xhr.onreadystatechange()
      },30)
    }
    window.XMLHttpRequest=FakeXHR
    return 'stubbed'
  })()`)

  // B. 光环命中测试：show 气泡 → 点中心 → 应触发 fire（stub 捕获 /inject）
  console.log('--- 测试B: 中心点击 ---')
  await evalJs(`window.__dswBubble.show('自测文本ABC', 500, 350)`)
  await sleep(300)
  let st = await evalJs('JSON.stringify(window.__dswBubble.state())')
  console.log('气泡状态:', st)
  const cx = 500, cy = 350 - 10 // show 内部锚点 y=350；CSS translate(-50%,-100%) → 中心约在 (500, 350-10-h/2)
  // 从 state 里取真实中心
  const rect = JSON.parse(st).rect
  const pcx = Math.round(rect.x + rect.w / 2)
  const pcy = Math.round(rect.y + rect.h / 2)
  console.log('气泡中心:', pcx, pcy)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pcx, y: pcy, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pcx, y: pcy, button: 'left', clickCount: 1 })
  await sleep(500)
  st = await evalJs('JSON.stringify(window.__dswBubble.state())')
  console.log('点击后状态:', st)
  const injects = await evalJs('JSON.stringify(window.__injectCalls||[])')
  console.log('捕获到的 /inject 调用:', injects ? injects.slice(0, 120) : '无')
  const passB = injects && injects.length > 0
  console.log('测试B(中心点击发送):', passB ? 'PASS' : 'FAIL')

  // C1. 环外按下：气泡应被销毁（现有设计）。注意光环半径 22px：
  //     气泡半宽约 56px，所以 x+150 才在光环外（上一版 +60 其实仍在光环内）
  console.log('--- 测试C1: 环外按下销毁 ---')
  await evalJs('window.__dswBubble.show("自测2", 500, 350)')
  await sleep(200)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 500 + 150, y: 350 + 80, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 500 + 150, y: 350 + 80, button: 'left', clickCount: 1 })
  await sleep(200)
  const gone = await evalJs('!window.__dswBubble.state().shown')
  console.log('环外按下后气泡消失:', gone ? 'PASS' : 'FAIL')

  // C2. 光环内（中心下方 14px，视觉在药丸外、光环内）按下：应命中 = 发送
  console.log('--- 测试C2: 光环内点击 ---')
  await evalJs('window.__dswBubble.show("自测3", 500, 350)')
  await sleep(200)
  const st2 = JSON.parse(await evalJs('JSON.stringify(window.__dswBubble.state())'))
  const hx = Math.round(st2.rect.x + st2.rect.w / 2)
  const hy = Math.round(st2.rect.y + st2.rect.h / 2 + 14) // 药丸外 14px、光环(18px)内
  await evalJs('window.__injectCalls=[]')
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: hy, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: hy, button: 'left', clickCount: 1 })
  await sleep(400)
  const injects2 = await evalJs('(window.__injectCalls||[]).length')
  console.log('光环内点击触发发送次数:', injects2, injects2 > 0 ? 'PASS' : 'FAIL')

  await evalJs('window.XMLHttpRequest = window.__realXHR')
  chrome.kill()
  console.log('=== 自测结束 ===')
  process.exit(0)
}

main().catch((e) => {
  console.error('自测异常:', e)
  process.exit(1)
})

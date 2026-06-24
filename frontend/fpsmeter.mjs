// 用 CDP 驱动真实 Edge(headed,走真 GPU),对运行中的前端采样 RAF 帧间隔算真实帧率。
// Node 22 自带 fetch / WebSocket,无需任何 npm 依赖。
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9222
const urls = process.argv.slice(2) // [label=url, ...]  例如 prod=http://localhost:4173/

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userDir = mkdtempSync(join(tmpdir(), 'fpsmeter-'))
const edge = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--no-first-run', '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--new-window', 'about:blank',
  '--window-size=1600,1000',
], { stdio: 'ignore' })

// 等 CDP 端口就绪
let version
for (let i = 0; i < 40; i++) {
  try { version = await (await fetch(`http://localhost:${PORT}/json/version`)).json(); break } catch { await sleep(250) }
}
if (!version) { console.error('CDP 未就绪'); edge.kill(); process.exit(1) }

// 找到 page target
let target
for (let i = 0; i < 20; i++) {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  target = list.find((t) => t.type === 'page')
  if (target?.webSocketDebuggerUrl) break
  await sleep(200)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let msgId = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
const cdp = (method, params = {}) => new Promise((res) => {
  const id = ++msgId
  pending.set(id, res)
  ws.send(JSON.stringify({ id, method, params }))
})

await cdp('Page.enable')
await cdp('Runtime.enable')

// 页面内:切到 WEIRD(最快)堆积封面 → 预热 12s → 边连续拖动旋转地球边采样 8s → 算统计
// 拖动会触发 symbol 碰撞 placement(主线程),这才是会掉帧的最重路径。
const sampler = `(async () => {
  const sp = [...document.querySelectorAll('button.speed')].find(b => /WEIRD/i.test(b.textContent));
  if (sp) sp.click();
  else { const pb = document.querySelector('button.ec[title="播放"]'); if (pb) pb.click(); }
  await new Promise(r => setTimeout(r, 12000));   // 预热:让封面堆满(最重场景)
  const cv = document.querySelector('#map canvas') || document.querySelector('canvas');
  const rect = cv.getBoundingClientRect();
  const cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
  const fire = (type, x, y, buttons) => cv.dispatchEvent(new MouseEvent(type, {
    bubbles:true, cancelable:true, view:window, clientX:x, clientY:y, button:0, buttons
  }));
  fire('mousedown', cx, cy, 1);
  const deltas = await new Promise(res => {
    const d = []; let last = performance.now(); const start = last; let a = 0;
    function tick(t){
      d.push(t - last); last = t;
      a += 0.25;                                   // 连续水平拖动 → 旋转地球
      fire('mousemove', cx + Math.sin(a)*220, cy + Math.cos(a*0.6)*60, 1);
      if (t - start < 8000) requestAnimationFrame(tick);
      else { fire('mouseup', cx, cy, 0); res(d); }
    }
    requestAnimationFrame(tick);
  });
  deltas.sort((a,b)=>a-b);
  const n = deltas.length, sum = deltas.reduce((a,b)=>a+b,0), avg = sum/n;
  const median = deltas[n>>1], p95 = deltas[Math.floor(n*0.95)], worst = deltas[n-1];
  const over16 = deltas.filter(x=>x>17).length, over33 = deltas.filter(x=>x>33).length;
  return JSON.stringify({
    frames:n, fpsAvg:+(1000/avg).toFixed(1), fpsMedian:+(1000/median).toFixed(1),
    msMedian:+median.toFixed(1), msP95:+p95.toFixed(1), msWorst:+worst.toFixed(1),
    pctOver16:+(100*over16/n).toFixed(0), pctOver33:+(100*over33/n).toFixed(0)
  });
})()`

for (const arg of urls) {
  const [label, url] = arg.includes('=') ? arg.split(/=(.+)/) : ['', arg]
  await cdp('Page.navigate', { url })
  await sleep(6000) // 等地图样式+数据加载
  const r = await cdp('Runtime.evaluate', { expression: sampler, awaitPromise: true, returnByValue: true })
  const val = r.result?.result?.value
  console.log(`RESULT ${label}: ${val ?? JSON.stringify(r.result)}`)
}

ws.close(); edge.kill()
process.exit(0)

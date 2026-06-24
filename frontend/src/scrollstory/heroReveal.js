// 第 1 页封面 hero:沿鼠标轨迹生成「左右展开」的像素毛边封面。
// 由 scrollStory.js 挂到 data-layer="0";同源 /api(经 vite 代理),返回 destroy()。
export function initHeroReveal(container) {
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ── 建 DOM(背景弧线 / canvas / 大标题) ──
  const lines = document.createElement('div');
  lines.className = 'hero-bg-lines';
  const linesSvg = document.createElementNS(SVGNS, 'svg');
  linesSvg.setAttribute('preserveAspectRatio', 'none');
  lines.appendChild(linesSvg);

  const canvas = document.createElement('canvas');
  canvas.className = 'hero-canvas';
  const ctx = canvas.getContext('2d');

  // 大标题:每行独立、行内逐字。改中文(如 ['世界','专辑地图'])同样逐字、行间接力。
  const TITLE_LINES = ['Music', 'Map'];
  const title = document.createElement('h1');
  title.className = 'hero-title';
  const charEls = [];   // { el, line, idx, len }
  TITLE_LINES.forEach((text, li) => {
    const lineEl = document.createElement('div');
    lineEl.className = 'hero-line';
    const chars = Array.from(text);
    chars.forEach((ch, ci) => {
      const span = document.createElement('span');
      span.className = 'hero-char';
      span.textContent = ch === ' ' ? ' ' : ch;
      lineEl.appendChild(span);
      charEls.push({ el: span, line: li, idx: ci, len: chars.length });
    });
    title.appendChild(lineEl);
  });

  // Map 下方的中文副标题:逐字、紧跟在标题之后一起左移退出(line 索引接在标题行后)
  const SUBTITLE = '全球流行专辑动态地图';
  const subtitle = document.createElement('div');
  subtitle.className = 'hero-subtitle';
  const subLine = document.createElement('div');
  subLine.className = 'hero-line';
  const subChars = Array.from(SUBTITLE);
  subChars.forEach((ch, ci) => {
    const span = document.createElement('span');
    span.className = 'hero-char';
    span.textContent = ch;
    subLine.appendChild(span);
    charEls.push({ el: span, line: TITLE_LINES.length, idx: ci, len: subChars.length });
  });
  subtitle.appendChild(subLine);

  container.append(lines, canvas, title, subtitle);
  const sceneLayer = container.closest('.scene-layer') || container;

  // ── heroMap 转场退出:由 scrollStory 传入进度 p(0..1)驱动 ──
  // 标题逐字左移(第 1 行先、第 2 行接力);黑胶弧线逐条右移退出(内侧先、外侧追,easeOutBack 过冲 → 弹力)
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const backEase = (t) => { const c1 = 1.70158, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };
  function heroSetExit(p) {
    const tp = clamp01(p / 0.44);                       // 标题在前 44% 内退完(黑幕 0.51 盖满前)
    const lineStarts = [0, 0.42, 0.52];                 // line0=Music line1=Map line2=中文副标题(接在 Map 之后退出)
    for (const c of charEls) {
      const lineStart = lineStarts[c.line] ?? 0.42;
      const start = lineStart + (c.idx / Math.max(1, c.len)) * 0.35;
      const cp = clamp01((tp - start) / 0.34);
      const e = cp * cp * (3 - 2 * cp);
      c.el.style.transform = `translateX(${(-e * 0.72 * (window.innerWidth || 1)).toFixed(1)}px)`;
      c.el.style.opacity = String(1 - e);
    }
    const lp = clamp01(p / 0.5);                        // 黑胶线在前 50% 内退完
    const exit = (W || window.innerWidth || 1) * 1.4;   // 右移足够多 → 出屏
    for (let k = 0; k < lineCircles.length; k++) {
      const norm = k / Math.max(1, lineCircles.length - 1);   // 0 内侧 .. 1 外侧
      const local = clamp01((lp - norm * 0.4) / 0.6);         // 外侧起步更晚 → 不等速
      lineCircles[k].el.setAttribute('transform', `translate(${(backEase(local) * exit).toFixed(1)},0)`);
    }
  }
  container.heroSetExit = heroSetExit;

  let dpr = 1, W = 0, H = 0;
  let coverW = 150, SPACING = 150, P = 12;
  const OPEN = 0.15, HOLD = 0.5, CLOSE = 0.15;
  let tiles = [];
  let lineCircles = [];   // 黑胶弧线,转场时逐条右移退出

  // ── 每 10 秒换一批真封面 ──
  let covers = [];
  let batchTimer = 0;
  function loadBatch() {
    fetch('/api/story/sample?n=160')
      .then((r) => r.json())
      .then((d) => {
        const fresh = [], seen = new Set();
        (d.albums || []).forEach((a) => {
          if (!a.c || seen.has(a.c)) return;
          seen.add(a.c);
          const im = new Image();
          im.onload = () => { fresh.push(im); if (covers.length === 0) covers = fresh; };
          im.src = `/api/covers/${a.c}`;
        });
        setTimeout(() => { if (fresh.length) { covers = fresh; bag.length = 0; } }, 1800);
      })
      .catch(() => { batchTimer = window.setTimeout(loadBatch, 2000); });
  }
  // 洗牌袋:把整池打乱后逐张取,取空再重洗 → 一轮内不重复;换批时清空袋子立即用新池
  let bag = [];
  function pickCover() {
    if (!covers.length) return null;
    if (!bag.length) {
      bag = covers.slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    return bag.pop();
  }

  // 一条波纹弧线的路径:沿圆周采样 + 径向正弦扰动(波数取整 → 首尾闭合平滑);相位随时间推 → 波沿弧线传播
  function lineD(L, t) {
    const N = 96;
    let d = '';
    for (let s = 0; s <= N; s++) {
      const th = (s / N) * Math.PI * 2;
      const rr = L.r + L.amp * Math.sin(L.k * th + L.phase + L.dir * t * L.speed);
      d += (s ? 'L' : 'M') + (L.cx + rr * Math.cos(th)).toFixed(1) + ' ' + (L.cy + rr * Math.sin(th)).toFixed(1);
    }
    return d + 'Z';
  }
  function updateLines(t) { for (const L of lineCircles) L.el.setAttribute('d', lineD(L, t)); }

  function buildLines() {
    while (linesSvg.firstChild) linesSvg.removeChild(linesSvg.firstChild);
    linesSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    lineCircles = [];
    const cx = W * 1.16, cy = H * 0.5;
    for (let i = 1; i <= 16; i++) {
      const r = W * 0.16 + i * (W * 0.072);
      const el = document.createElementNS(SVGNS, 'path');
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', 'rgba(255,255,255,0.085)');
      el.setAttribute('stroke-width', '1.8');
      const L = {
        el, cx, cy, r,
        amp: 5 + Math.random() * 12,             // 振幅(音波高度)
        k: 5 + (Math.random() * 9 | 0),          // 整数波数 → 闭合平滑
        speed: 0.5 + Math.random() * 1.3,        // 波传播速度
        dir: Math.random() < 0.5 ? 1 : -1,       // 上→下 / 下→上 随机
        phase: Math.random() * Math.PI * 2,
      };
      el.setAttribute('d', lineD(L, 0));
      linesSvg.appendChild(el);
      lineCircles.push(L);                        // i=1 最内侧 → 转场时先走
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = container.clientWidth; H = container.clientHeight;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    coverW = Math.round(150 * dpr);
    SPACING = Math.round(150 * dpr);
    P = Math.round(12 * dpr);
    tiles = [];
    buildLines();
  }

  // ── 沿轨迹采样生成 ──
  let px = 0, py = 0, hasPrev = false, carry = 0;
  function spawn(x, y, now) {
    const img = pickCover();
    if (!img) return;
    const cols = Math.ceil(coverW / P), rows = Math.ceil(coverW / P);
    const present = new Uint8Array(cols * rows);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const edge = Math.min(i, cols - 1 - i, j, rows - 1 - j);
        const p = edge >= 2 ? 1 : (edge + 0.5) / 2.5;
        present[j * cols + i] = Math.random() < p ? 1 : 0;
      }
    }
    const jit = new Float32Array(rows);
    for (let j = 0; j < rows; j++) jit[j] = Math.random() * 2 - 1;
    tiles.push({ cx: x, cy: y, img, born: now, cols, rows, present, jit });
  }
  function trail(x0, y0, x1, y1, now) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy);
    if (L === 0) return;
    let along = SPACING - carry;
    while (along <= L) {
      const t = along / L;
      spawn(x0 + dx * t, y0 + dy * t, now);
      along += SPACING;
    }
    carry = L - (along - SPACING);
  }

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    const now = performance.now() / 1000;
    if (hasPrev) trail(px, py, x, y, now);
    px = x; py = y; hasPrev = true;
  };
  const onLeave = () => { hasPrev = false; carry = 0; };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);

  const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (t * 6 - 15) + 10));

  let raf = 0, disposed = false;
  function frame() {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    // 本页不可见时不渲染(也没指针事件 → 不会新生成)
    if (!sceneLayer.classList.contains('is-active') && tiles.length === 0) return;
    const now = performance.now() / 1000;
    updateLines(now);                       // 音波弧线:每帧推进波相位
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const half = coverW / 2;
    const alive = [];
    for (const c of tiles) {
      const age = now - c.born;
      let f;
      if (age < OPEN) f = age / OPEN;
      else if (age < OPEN + HOLD) f = 1;
      else if (age < OPEN + HOLD + CLOSE) f = 1 - (age - OPEN - HOLD) / CLOSE;
      else continue;
      const env = sm(f);
      const { cols, rows, present, jit, img } = c;
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const left = c.cx - half, top = c.cy - half;
      const centerCol = (cols - 1) / 2;
      const halfCols = (cols / 2) * env;
      for (let j = 0; j < rows; j++) {
        const thresh = halfCols + jit[j];
        for (let i = 0; i < cols; i++) {
          if (!present[j * cols + i]) continue;
          if (Math.abs(i - centerCol) > thresh) continue;
          const dx = left + i * P, dw = Math.min(P, coverW - i * P);
          const dy = top + j * P, dh = Math.min(P, coverW - j * P);
          if (dw <= 0 || dh <= 0) continue;
          const sx = (i * P / coverW) * iw, sw = (dw / coverW) * iw;
          const sy = (j * P / coverW) * ih, sh = (dh / coverW) * ih;
          ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
        }
      }
      alive.push(c);
    }
    tiles = alive;
  }

  const onResize = () => { resize(); heroSetExit(0); };
  window.addEventListener('resize', onResize);
  resize();
  heroSetExit(0);
  loadBatch();
  batchTimer = window.setInterval(loadBatch, 10000);
  raf = requestAnimationFrame(frame);

  // 调试钩子:后续弧线右移/切换
  container.moveHeroLines = (x) => lines.style.setProperty('--hero-lines-x', `${x}px`);

  return function destroy() {
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    window.clearInterval(batchTimer);
    window.removeEventListener('resize', onResize);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    lines.remove(); canvas.remove(); title.remove();
  };
}

// three.js 封面地球 · 真实时间轴调度版(阶段 3+4,独立测试页)
// 移植现有 MapGlobe 引擎:按各国各年发行量控制出现节奏 + 环形替换最老封面。
// 封面全部预加载进一张纹理图集 → 运行期只改 instance 的 UV/出现时间 → 零加图。
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

// 配色(参考图1:深紫太空 / 青灰海洋 / 粉白陆地 / 白辉光)
const C_SPACE = '#2b2738', C_OCEAN = '#6f8c8e', C_LAND = '#f2dfe1'

const params = new URLSearchParams(location.search)
const PER = Number(params.get('per') ?? 200)        // 后端每国每年候选数(per=0 → 全量,pool 只回 {y,c})
const CAP_TOTAL = Number(params.get('cap') ?? 40000) // 图集封面上限
const DUR = Number(params.get('dur') ?? 30)          // 播放时长(秒)
const SIZE = Number(params.get('size') ?? 0.02)
const ONLY = params.get('onlyiso')                   // 只展示某国封面(检查映射用),如 ?onlyiso=CN
const CELL = Number(params.get('cell') ?? 48)        // 图集每格像素(?cell=32 → 全量,8 图集容量 52.4 万)
const ATLAS_PX = 8192                                 // 单张图集边长(多图集突破单纹理 16384 上限)
const GRID_A = Math.floor(ATLAS_PX / CELL)            // 每图集每边格数(48→170,32→256)
const PER_ATLAS = GRID_A * GRID_A                     // 每图集容量(48→28900,32→65536)
const N_ATLAS_MAX = 8                                 // shader sampler 上限(32px×8 张 ≈ 52 万张封面)
const W = window as unknown as Record<string, unknown>
const hud = document.getElementById('hud')!

const YEAR_START = 2010, NUM_YEARS = 16
const R = 1.003
function ll2v(lon: number, lat: number, r = R): [number, number, number] {
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180
  return [r * Math.cos(phi) * Math.cos(lam), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lam)]
}
function shuffle<T>(a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]] } return a }
function cumOf(prefix: number[], t: number) {
  const fy = Math.floor(t); if (fy >= NUM_YEARS) return prefix[NUM_YEARS]
  const frac = t - fy; return prefix[fy] + frac * (prefix[fy + 1] - prefix[fy])
}

// ── three 场景 ──
const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
const labelRenderer = new CSS2DRenderer()
labelRenderer.setSize(innerWidth, innerHeight)
labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none'
document.body.appendChild(labelRenderer.domElement)
const scene = new THREE.Scene(); scene.background = new THREE.Color(C_SPACE)
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100)
camera.position.set(0, 0.5, 2.6)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true; controls.minDistance = 1.2; controls.maxDistance = 6
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); labelRenderer.setSize(innerWidth, innerHeight) })

// 海洋球
scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), new THREE.MeshBasicMaterial({ color: C_OCEAN })))

// 星空
{
  const n = 1800, pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { const r = 20 + Math.random() * 30, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1); pos[i * 3] = r * Math.sin(ph) * Math.cos(th); pos[i * 3 + 1] = r * Math.cos(ph); pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th) }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, sizeAttenuation: true, transparent: true, opacity: 0.85 })))
}

// 地球边缘淡白辉光(fresnel,略大球 backside + additive,贴着边缘的薄光圈)
scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.045, 96, 96), new THREE.ShaderMaterial({
  transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`,
  fragmentShader: `varying vec3 vN; varying vec3 vP; void main(){ float f=pow(clamp(1.0-abs(dot(normalize(vN),normalize(-vP))),0.0,1.0),2.2); gl_FragColor=vec4(1.0,1.0,1.0,f*0.5); }`,
})))

type Album = { t: string; a: string; y: number; c: string }
type CProp = { iso: string; name: string; continent: string; cx: number; cy: number; area: number; covers: number }
type GeoFC = { features: { properties: CProp; geometry: { type: string; coordinates: number[][][] | number[][][][] } }[] }

// 与 ll2v 同一经纬映射的 equirectangular UV 球 → 贴 canvas 纹理时和封面/白点严格对齐
function makeUVSphere(r: number, sx = 360, sy = 180) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = []
  for (let j = 0; j <= sy; j++) {
    const lat = 90 - 180 * j / sy
    for (let i = 0; i <= sx; i++) { const lng = -180 + 360 * i / sx; const v = ll2v(lng, lat, r); pos.push(v[0], v[1], v[2]); uv.push(i / sx, 1 - j / sy) }
  }
  for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) { const a = j * (sx + 1) + i, b = a + 1, c = a + sx + 1, d = c + 1; idx.push(a, c, b, b, c, d) }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx)
  return g
}

// 矢量陆地:在 equirectangular canvas 上填充真实国界多边形(平滑)+ 描国界线,贴到 UV 球
function buildLand(fc: GeoFC) {
  const TW = 8192, TH = 4096
  const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH
  const g = cv.getContext('2d')!
  const X = (lng: number) => (lng + 180) / 360 * TW, Y = (lat: number) => (90 - lat) / 180 * TH
  g.lineWidth = 1.6; g.lineJoin = 'round'
  for (const f of fc.features) {
    const polys = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]) as number[][][][]
    for (const poly of polys) {
      g.beginPath()
      for (const ring of poly) ring.forEach((p, i) => { const x = X(p[0]), y = Y(p[1]); i === 0 ? g.moveTo(x, y) : g.lineTo(x, y) })
      g.closePath()
      g.shadowBlur = 0; g.fillStyle = C_LAND; g.fill('evenodd')          // 陆地填充
      g.shadowColor = '#ff9db0'; g.shadowBlur = 7; g.strokeStyle = '#d98a98'; g.stroke() // 国界 + 浅粉辉光
    }
  }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
  scene.add(new THREE.Mesh(makeUVSphere(1.001), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })))
}

// 文字标注(CSS2D):大洲(大字)+ 面积较大的国家(小字),背面自动隐藏
const labels: { el: CSS2DObject; pos: THREE.Vector3 }[] = []
function addLabel(text: string, lng: number, lat: number, cls: string) {
  const div = document.createElement('div'); div.className = cls; div.textContent = text
  const obj = new CSS2DObject(div); const v = ll2v(lng, lat, 1.02)
  obj.position.set(v[0], v[1], v[2]); scene.add(obj)
  labels.push({ el: obj, pos: new THREE.Vector3(v[0], v[1], v[2]) })
}
function buildLabels(fc: GeoFC) {
  const cont = new Map<string, { x: number; y: number; w: number }>()
  // 所有国家(含小岛国)都标名字,不再只取面积前 70
  for (const f of fc.features) { const p = f.properties; if (!p.name || /seven seas|ocean/i.test(p.continent || '')) continue; addLabel(p.name, p.cx, p.cy, 'lbl-country') }
  for (const f of fc.features) {
    const p = f.properties; if (!p.continent || /seven seas|ocean/i.test(p.continent)) continue // 跳过"Seven seas (open ocean)"
    const c = cont.get(p.continent) ?? { x: 0, y: 0, w: 0 }
    c.x += p.cx * p.area; c.y += p.cy * p.area; c.w += p.area; cont.set(p.continent, c)
  }
  cont.forEach((c, name) => addLabel(name.toUpperCase(), c.x / c.w, c.y / c.w, 'lbl-cont'))
  // 海洋注记(硬编码主要大洋,粉色斜体)
  const OCEANS: [string, number, number][] = [
    ['Pacific Ocean', -150, 0], ['Pacific Ocean', 175, 10], ['Atlantic Ocean', -30, 5],
    ['Indian Ocean', 78, -28], ['Southern Ocean', 25, -62], ['Arctic Ocean', -40, 78],
  ]
  for (const [name, lng, lat] of OCEANS) addLabel(name, lng, lat, 'lbl-ocean')
}
// 按封面密度加密格点:封面越多的国家,每个格子里补越多抖动点(US/欧洲/南美等)
const MAX_K = 3, DENS_DIV = 40   // 加密上限调低 → 美国等大国不过密(减淡)
function densify(cents: { iso: string; lng: number; lat: number }[], fc: GeoFC): [number, number][] {
  const cellCnt = new Map<string, number>(); for (const c of cents) cellCnt.set(c.iso, (cellCnt.get(c.iso) ?? 0) + 1)
  const cov = new Map<string, number>(); for (const f of fc.features) cov.set(f.properties.iso, f.properties.covers ?? 0)
  const out: [number, number][] = []
  for (const c of cents) {
    if (c.iso === 'AQ') continue   // 南极点太密,删掉
    const density = (cov.get(c.iso) ?? 0) / (cellCnt.get(c.iso) ?? 1)
    const k = Math.max(1, Math.min(MAX_K, Math.round(density / DENS_DIV)))
    out.push([c.lng, c.lat])
    for (let j = 1; j < k; j++) out.push([c.lng + (Math.random() - 0.5) * 0.75, c.lat + (Math.random() - 0.5) * 0.75])
  }
  return out
}
// 白色发光圆点阵(小、圆、发光,渲染在陆地之上不被盖;有封面时被封面盖住)
function buildDots(pts: [number, number][]) {
  const n = pts.length, pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) { const v = ll2v(pts[i][0], pts[i][1], 1.004); pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2] }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const m = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 9.0 } },
    transparent: true, depthWrite: false, depthTest: true,
    vertexShader: `uniform float uSize; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=uSize*(1.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
    // 实心白核(盖住粉白陆地,清晰可见)+ 外圈柔光晕(发光感)
    fragmentShader: `void main(){
      float d=length(gl_PointCoord-0.5); if(d>0.5) discard;
      float core=smoothstep(0.30,0.16,d);
      float glow=smoothstep(0.5,0.16,d)*0.45;
      gl_FragColor=vec4(1.0,1.0,1.0, max(core, glow)); }`,
  })
  const p = new THREE.Points(g, m); p.renderOrder = 2; scene.add(p)
}

async function main() {
  hud.textContent = '取数据…'
  const hasCover = CAP_TOTAL > 0
  const [cents, countries, alb] = await Promise.all([
    fetch('/api/grids/centroids').then((r) => r.json()),
    fetch('/api/countries/geojson').then((r) => r.json()),
    hasCover ? fetch(`/api/timeline/albums?per=${PER}`).then((r) => r.json()) : Promise.resolve({ counts: {}, pool: {} }),
  ])
  hud.textContent = '构建底图…'
  buildLand(countries as GeoFC)
  buildLabels(countries as GeoFC)
  buildDots(densify(cents as { iso: string; lng: number; lat: number }[], countries as GeoFC))
  if (ONLY) {  // 相机对准目标国
    const f = (countries as GeoFC).features.find((x) => x.properties.iso === ONLY)
    if (f) { const v = ll2v(f.properties.cx, f.properties.cy, 1.75); camera.position.set(v[0], v[1], v[2]); controls.target.set(0, 0, 0); controls.update() }
  }

  const clock = new THREE.Clock()
  let stepFn: ((p: number, n: number) => void) | null = null
  let coverMat: THREE.ShaderMaterial | null = null

  if (hasCover) {
  const counts: Record<string, Record<string, number>> = alb.counts
  const pool: Record<string, Album[]> = alb.pool ?? {}

  // ── 选封面进 N 张图集,建 mbid→[atlasIdx, u, v] ──
  const chosen: string[] = []
  const mbidUV = new Map<string, [number, number, number]>()
  const srcArrs = ONLY ? [pool[ONLY] ?? []] : Object.values(pool)  // onlyiso 时只取该国
  const capMax = Math.min(CAP_TOTAL, PER_ATLAS * N_ATLAS_MAX)
  { let ri = 0, added = true  // 轮转取,保证覆盖所有国家(而非只前面几个字母序的国家)
    while (chosen.length < capMax && added) { added = false; for (const arr of srcArrs) { if (ri < arr.length) { chosen.push(arr[ri].c); added = true; if (chosen.length >= capMax) break } } ri++ } }
  const cellUV = CELL / ATLAS_PX
  const N_ATLAS = Math.max(1, Math.ceil(chosen.length / PER_ATLAS))
  for (let k = 0; k < chosen.length; k++) {
    const g = Math.floor(k / PER_ATLAS), j = k % PER_ATLAS
    mbidUV.set(chosen[k], [g, (j % GRID_A) * cellUV, Math.floor(j / GRID_A) * cellUV])
  }

  hud.textContent = `拼 ${N_ATLAS} 张图集 / ${chosen.length} 张封面…`
  const ctxs: CanvasRenderingContext2D[] = []
  const canvases: HTMLCanvasElement[] = []
  for (let g = 0; g < N_ATLAS; g++) {
    const cv = document.createElement('canvas'); cv.width = cv.height = ATLAS_PX
    const cx = cv.getContext('2d')!; cx.fillStyle = '#222'; cx.fillRect(0, 0, ATLAS_PX, ATLAS_PX)
    canvases.push(cv); ctxs.push(cx)
  }
  let loaded = 0
  await new Promise<void>((resolve) => {
    let idx = 0, active = 0; const CC = 64
    const pump = () => {
      while (active < CC && idx < chosen.length) {
        const k = idx++; active++
        const g = Math.floor(k / PER_ATLAS), j = k % PER_ATLAS, dx = (j % GRID_A) * CELL, dy = Math.floor(j / GRID_A) * CELL
        fetch(`/api/covers/${chosen[k]}`).then((r) => r.ok ? r.blob() : Promise.reject())
          .then((b) => createImageBitmap(b, { resizeWidth: CELL, resizeHeight: CELL }))
          .then((bmp) => ctxs[g].drawImage(bmp, dx, dy))
          .catch(() => { mbidUV.delete(chosen[k]) })
          .finally(() => { active--; loaded++; if (loaded % 2000 === 0) hud.textContent = `拼图集 ${loaded}/${chosen.length}`; (idx >= chosen.length && active === 0) ? resolve() : pump() })
      }
    }
    pump()
  })
  const texes = canvases.map((cv) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.flipY = false; return t })
  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); dummy.needsUpdate = true
  const samplers: Record<string, { value: THREE.Texture }> = {}
  for (let g = 0; g < N_ATLAS_MAX; g++) samplers['uA' + g] = { value: texes[g] ?? dummy }

  // ── 每格一个 instance(位置固定),按 iso 分组 ──
  const flatPos: [number, number, number][] = []
  const cellInstByIso = new Map<string, number[]>()
  for (const c of cents as { iso: string; lng: number; lat: number }[]) {
    const i = flatPos.length; flatPos.push(ll2v(c.lng, c.lat, 1.006))
    let a = cellInstByIso.get(c.iso); if (!a) { a = []; cellInstByIso.set(c.iso, a) }; a.push(i)
  }
  cellInstByIso.forEach((arr) => shuffle(arr))
  const COUNT = flatPos.length

  // ── 每(国,年)封面桶(只含有 UV 的) + prefix 出现节奏 ──
  function buildPools() {
    const m = new Map<string, Map<number, Album[]>>()
    for (const [iso, arr] of Object.entries(pool)) {
      const ym = new Map<number, Album[]>()
      for (const a of arr) { if (!mbidUV.has(a.c)) continue; let b = ym.get(a.y); if (!b) { b = []; ym.set(a.y, b) } b.push(a) }
      ym.forEach((b) => shuffle(b)); m.set(iso, ym)
    }
    return m
  }
  let poolByYear = buildPools()
  const prefixByIso = new Map<string, number[]>()
  cellInstByIso.forEach((_cells, iso) => {
    const ym = poolByYear.get(iso); const pre = new Array<number>(NUM_YEARS + 1); pre[0] = 0
    for (let i = 0; i < NUM_YEARS; i++) { const yr = YEAR_START + i; pre[i + 1] = pre[i] + Math.min(counts[String(yr)]?.[iso] ?? 0, ym?.get(yr)?.length ?? 0) }
    prefixByIso.set(iso, pre)
  })
  function pickAlbum(iso: string, year: number): Album | undefined {
    const ym = poolByYear.get(iso); if (!ym) return
    let arr = ym.get(year)
    if (!arr?.length) { for (let y = year - 1; y >= YEAR_START; y--) { const a = ym.get(y); if (a?.length) { arr = a; break } } }
    if (!arr?.length) { for (let y = year + 1; y < YEAR_START + NUM_YEARS; y++) { const a = ym.get(y); if (a?.length) { arr = a; break } } }
    return arr?.length ? arr.pop() : undefined
  }

  // ── InstancedMesh ──
  const baseGeo = new THREE.PlaneGeometry(1, 1)
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = baseGeo.index; geo.attributes.position = baseGeo.attributes.position; geo.attributes.uv = baseGeo.attributes.uv
  geo.instanceCount = COUNT
  const iPos = new Float32Array(COUNT * 3), iUV = new Float32Array(COUNT * 2), iBorn = new Float32Array(COUNT), iAtlas = new Float32Array(COUNT)
  // iBorn=1e9(未来)表示"未点亮":shader 里 age=uTime-1e9<0 → 不显示。点亮时改成当前时间。
  for (let i = 0; i < COUNT; i++) { iPos[i * 3] = flatPos[i][0]; iPos[i * 3 + 1] = flatPos[i][1]; iPos[i * 3 + 2] = flatPos[i][2]; iBorn[i] = 1e9 }
  const aPos = new THREE.InstancedBufferAttribute(iPos, 3)
  const aUV = new THREE.InstancedBufferAttribute(iUV, 2); aUV.setUsage(THREE.DynamicDrawUsage)
  const aBorn = new THREE.InstancedBufferAttribute(iBorn, 1); aBorn.setUsage(THREE.DynamicDrawUsage)
  const aAtlas = new THREE.InstancedBufferAttribute(iAtlas, 1); aAtlas.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('iPos', aPos); geo.setAttribute('iUV', aUV); geo.setAttribute('iBorn', aBorn); geo.setAttribute('iAtlas', aAtlas)
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCell: { value: cellUV }, uSize: { value: SIZE }, ...samplers },
    transparent: true, depthTest: true, depthWrite: false,
    vertexShader: `uniform float uTime,uSize,uCell; attribute vec3 iPos; attribute vec2 iUV; attribute float iBorn; attribute float iAtlas;
      varying vec2 vUv; varying float vOp; varying float vAtlas;
      float eob(float x){ float c1=1.70158,c3=c1+1.0; float t=x-1.0; return 1.0+c3*t*t*t+c1*t*t; }
      void main(){ float age=uTime-iBorn; float t=clamp(age/0.65,0.0,1.0);
        float scale=age<0.0?0.0:max(0.0,eob(t)); vOp=age<0.0?0.0:clamp(age/0.4,0.0,1.0); vAtlas=iAtlas;
        vUv=iUV+vec2(uv.x,1.0-uv.y)*uCell; vec4 mv=modelViewMatrix*vec4(iPos,1.0); mv.xy+=position.xy*uSize*scale;
        gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D uA0,uA1,uA2,uA3,uA4,uA5,uA6,uA7; varying vec2 vUv; varying float vOp; varying float vAtlas;
      void main(){ if(vOp<0.02) discard; int a=int(vAtlas+0.5); vec3 c;
        if(a==0)c=texture2D(uA0,vUv).rgb; else if(a==1)c=texture2D(uA1,vUv).rgb; else if(a==2)c=texture2D(uA2,vUv).rgb; else if(a==3)c=texture2D(uA3,vUv).rgb;
        else if(a==4)c=texture2D(uA4,vUv).rgb; else if(a==5)c=texture2D(uA5,vUv).rgb; else if(a==6)c=texture2D(uA6,vUv).rgb; else c=texture2D(uA7,vUv).rgb;
        gl_FragColor=vec4(c,vOp); }`,
  })
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; scene.add(mesh)

  // ── 引擎状态 ──
  const appeared = new Map<string, number>()
  let lastP = 0, lastNow = 0
  const APPEAR_S = 0.65   // 封面出现动画时长;每格翻面间隔不短于它,密集国家才不会"没冒出来就被覆盖"
  function reset() { appeared.clear(); poolByYear = buildPools(); iBorn.fill(1e9); aBorn.needsUpdate = true }

  coverMat = mat
  stepFn = function step(progress: number, now: number) {
    if (progress < lastP - 1e-6) reset()
    const dt = Math.min(0.1, Math.max(0, now - lastNow)); lastNow = now
    lastP = progress
    const t = progress * NUM_YEARS
    const curYear = YEAR_START + Math.min(Math.floor(t), NUM_YEARS - 1)
    let dirty = false
    cellInstByIso.forEach((cells, iso) => {
      const prefix = prefixByIso.get(iso); if (!prefix) return
      const cap = cells.length
      const target = Math.round(cumOf(prefix, t))
      let app = appeared.get(iso) ?? 0
      if (target <= app) return
      // 限速:每格约 APPEAR 秒翻一次,密集国家(GB/JP)稳定 churn 而非瞬间覆盖
      const end = Math.min(target, app + Math.max(1, Math.ceil(cap * dt / APPEAR_S)))
      for (; app < end; app++) {
        const inst = cells[app % cap]
        const al = pickAlbum(iso, curYear); if (!al) continue
        const uv = mbidUV.get(al.c)!
        iAtlas[inst] = uv[0]; iUV[inst * 2] = uv[1]; iUV[inst * 2 + 1] = uv[2]; iBorn[inst] = now; dirty = true
      }
      appeared.set(iso, app)
    })
    if (dirty) { aUV.needsUpdate = true; aBorn.needsUpdate = true; aAtlas.needsUpdate = true }
  }
  } // end if (hasCover)

  W.__frames = 0; W.__controls = controls; W.__ready = true
  hud.textContent = hasCover ? 'three · 播放中(拖动旋转)' : 'three · 仅底图'
  // 标注背面隐藏:格子点朝相机的半球才显示
  const _v = new THREE.Vector3(), _cam = new THREE.Vector3()
  function updateLabels() {
    _cam.copy(camera.position).normalize()
    for (const l of labels) l.el.visible = _v.copy(l.pos).normalize().dot(_cam) > 0.12
  }
  function animate() {
    requestAnimationFrame(animate)
    const el = clock.getElapsedTime()
    if (hasCover && stepFn && coverMat) { coverMat.uniforms.uTime.value = el; stepFn(Math.min(el / DUR, 1), el) }
    controls.update()
    updateLabels()
    renderer.render(scene, camera)
    labelRenderer.render(scene, camera)
    W.__frames = (W.__frames as number) + 1
  }
  animate()
}
main()

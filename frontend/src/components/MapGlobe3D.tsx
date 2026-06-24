// three.js 封面地球(接入 App 版):props 接口与 MapGlobe 一致,可切换。
// 由 App 时间轴 progress 驱动出现/替换;点击封面 → onCoverClick → 复用 Spotify 弹窗。
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { Album } from '../types'

const C_SPACE = '#2b2738', C_OCEAN = '#6f8c8e', C_LAND = '#f2dfe1'
const YEAR_START = 2011, NUM_YEARS = 15
// 全量显示:per=0(后端不截断,返回每国每年全部封面,pool 只回 {y,c});
// CELL=32 → 每图集 256²=65536 格,8 张图集容量 52.4 万 ≥ 全部已下载封面(~48.9 万)。VRAM≈2GB。
const PER = 0, CELL = 32, SIZE = 0.02
const ATLAS_PX = 8192, GRID_A = Math.floor(ATLAS_PX / CELL), PER_ATLAS = GRID_A * GRID_A, N_ATLAS_MAX = 8
const COVER_CAP = PER_ATLAS * N_ATLAS_MAX  // 524288:8 图集容量上限(超出部分丢弃,正常不会触发)
const MAX_K = 3, DENS_DIV = 40   // 按各国封面数加密格点:专辑多的国家每格补抖动点 → 更多封面坑位
const GRID_EA = new URLSearchParams(location.search).get('grid') === 'ea'  // ?grid=ea:用等面积网格
// 标注随相机距离缩放:s = (REF_D/距离)^POW,带幂次 → 放大端更大、缩小端更小。可调
// 大洲额外乘 LABEL_CONT_MULT(比国家更大,约国家:大洲 = 2:3)
const LABEL_REF_D = 2.1, LABEL_POW = 2, LABEL_S_MIN = 0.3, LABEL_S_MAX = 3.2, LABEL_CONT_MULT = 1.4, LABEL_OCEAN_MULT = 2


function ll2v(lon: number, lat: number, r = 1.003): [number, number, number] {
  const phi = (lat * Math.PI) / 180, lam = (lon * Math.PI) / 180
  return [r * Math.cos(phi) * Math.cos(lam), r * Math.sin(phi), -r * Math.cos(phi) * Math.sin(lam)]
}
function shuffle<T>(a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]] } return a }
function cumOf(prefix: number[], t: number) { const fy = Math.floor(t); if (fy >= NUM_YEARS) return prefix[NUM_YEARS]; const f = t - fy; return prefix[fy] + f * (prefix[fy + 1] - prefix[fy]) }

type CProp = { iso: string; name: string; continent: string; cx: number; cy: number; area: number; covers: number }
type GeoFC = { features: { properties: CProp; geometry: { type: string; coordinates: number[][][] | number[][][][] } }[] }
type Cent = { iso: string; lng: number; lat: number }

type Props = {
  progress: number
  playing: boolean
  resetSignal: number
  auroraOn?: boolean
  onCoverClick?: (a: Album) => void
  onAlbumsLoaded?: (a: Album[]) => void
  onLoadingChange?: (msg: string | null) => void   // 把图集加载状态冒泡出去(第 1 页也能显示)
  genreFilter?: string                              // 'all' | 'bucket:Rock' | 'fine:rock'
  onGenresLoaded?: (groups: GenreGroup[]) => void   // manifest 里的曲风清单(供下拉框)
}

export type GenreGroup = { bucket: string; count: number; fines: { name: string; count: number }[] }

export default function MapGlobe3D({ progress, playing, resetSignal, auroraOn = true, onCoverClick, onAlbumsLoaded, onLoadingChange, genreFilter = 'all', onGenresLoaded }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState<string | null>('初始化…')
  useEffect(() => { onLoadingChange?.(loading) }, [loading, onLoadingChange])   // 状态变化 → 冒泡给上层(第 1 页 loading 字样)
  const onGenresRef = useRef(onGenresLoaded); useEffect(() => { onGenresRef.current = onGenresLoaded }, [onGenresLoaded])
  const applyGenreRef = useRef<((v: string) => void) | null>(null)
  const genreFilterRef = useRef(genreFilter); useEffect(() => { genreFilterRef.current = genreFilter }, [genreFilter])
  useEffect(() => { applyGenreRef.current?.(genreFilter) }, [genreFilter])   // 下拉选择 → 重过滤封面池
  const auroraMeshRef = useRef<THREE.Object3D | null>(null)   // 极光网格,供开关切显隐
  const auroraOnRef = useRef(auroraOn)
  useEffect(() => { auroraOnRef.current = auroraOn; if (auroraMeshRef.current) auroraMeshRef.current.visible = auroraOn }, [auroraOn])
  const progressRef = useRef(0); useEffect(() => { progressRef.current = progress }, [progress])
  const playingRef = useRef(false); useEffect(() => { playingRef.current = playing }, [playing])
  const onClickRef = useRef(onCoverClick); useEffect(() => { onClickRef.current = onCoverClick }, [onCoverClick])
  const onLoadedRef = useRef(onAlbumsLoaded); useEffect(() => { onLoadedRef.current = onAlbumsLoaded }, [onAlbumsLoaded])
  const resetRef = useRef(resetSignal)
  useEffect(() => { resetRef.current = resetSignal }, [resetSignal])

  useEffect(() => {
    const container = containerRef.current!
    // 所在 scroll story 场景层:不在地图页(未 is-active)时跳过渲染,省 GPU、让其余场景更顺
    const sceneLayerEl = container.closest('.scene-layer')
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setSize(container.clientWidth, container.clientHeight)
    container.appendChild(renderer.domElement)
    const labelRenderer = new CSS2DRenderer()
    labelRenderer.setSize(container.clientWidth, container.clientHeight)
    labelRenderer.domElement.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none'
    container.appendChild(labelRenderer.domElement)

    const scene = new THREE.Scene(); scene.background = new THREE.Color(C_SPACE)
    const camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.01, 100)
    camera.position.set(0, 0.5, 2.6)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.minDistance = 1.2; controls.maxDistance = 6
    const onResize = () => { const w = container.clientWidth, h = container.clientHeight; camera.aspect = w / h; camera.updateProjectionMatrix(); renderer.setSize(w, h); labelRenderer.setSize(w, h) }
    addEventListener('resize', onResize)

    const oceanMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), new THREE.MeshBasicMaterial({ color: C_OCEAN }))
    scene.add(oceanMesh)
    // 星空
    { const n = 1800, p = new Float32Array(n * 3); for (let i = 0; i < n; i++) { const r = 20 + Math.random() * 30, t = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1); p[i * 3] = r * Math.sin(ph) * Math.cos(t); p[i * 3 + 1] = r * Math.cos(ph); p[i * 3 + 2] = r * Math.sin(ph) * Math.sin(t) } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.85 }))) }
    // 边缘辉光
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1.045, 96, 96), new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; varying vec3 vP; void main(){ vN=normalize(normalMatrix*normal); vec4 mv=modelViewMatrix*vec4(position,1.0); vP=mv.xyz; gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vP; void main(){ float f=pow(clamp(1.0-abs(dot(normalize(vN),normalize(-vP))),0.0,1.0),2.2); gl_FragColor=vec4(1.0,1.0,1.0,f*0.5); }`,
    })))

    // ── 底图构建函数 ──
    function makeUVSphere(r: number, sx = 360, sy = 180) {
      const pos: number[] = [], uv: number[] = [], idx: number[] = []
      for (let j = 0; j <= sy; j++) { const lat = 90 - 180 * j / sy; for (let i = 0; i <= sx; i++) { const lng = -180 + 360 * i / sx; const v = ll2v(lng, lat, r); pos.push(v[0], v[1], v[2]); uv.push(i / sx, 1 - j / sy) } }
      for (let j = 0; j < sy; j++) for (let i = 0; i < sx; i++) { const a = j * (sx + 1) + i, b = a + 1, c = a + sx + 1, d = c + 1; idx.push(a, c, b, b, c, d) }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); return g
    }
    function buildLand(fc: GeoFC) {
      const TW = 8192, TH = 4096, cv = document.createElement('canvas'); cv.width = TW; cv.height = TH
      const g = cv.getContext('2d')!, X = (lng: number) => (lng + 180) / 360 * TW, Y = (lat: number) => (90 - lat) / 180 * TH
      g.lineWidth = 1.6; g.lineJoin = 'round'
      for (const f of fc.features) {
        const polys = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]) as number[][][][]
        for (const poly of polys) {
          g.beginPath(); for (const ring of poly) ring.forEach((p, i) => { const x = X(p[0]), y = Y(p[1]); i === 0 ? g.moveTo(x, y) : g.lineTo(x, y) }); g.closePath()
          g.shadowBlur = 0; g.fillStyle = C_LAND; g.fill('evenodd'); g.shadowColor = '#ff9db0'; g.shadowBlur = 7; g.strokeStyle = '#d98a98'; g.stroke()
        }
      }
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4
      scene.add(new THREE.Mesh(makeUVSphere(1.001), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })))
    }
    const labels: { el: CSS2DObject; pos: THREE.Vector3; span: HTMLSpanElement; mult: number }[] = []
    function addLabel(text: string, lng: number, lat: number, cls: string) {
      // 文字放内层 span(用 transform:scale 缩放,不与 CSS2DRenderer 设在外层 div 上的 transform 冲突)
      const div = document.createElement('div'); div.className = cls
      const span = document.createElement('span'); span.textContent = text; span.style.display = 'inline-block'; span.style.transformOrigin = 'center'; div.appendChild(span)
      const obj = new CSS2DObject(div); const v = ll2v(lng, lat, 1.02); obj.position.set(v[0], v[1], v[2]); scene.add(obj)
      labels.push({ el: obj, pos: new THREE.Vector3(v[0], v[1], v[2]), span, mult: cls === 'lbl-cont' ? LABEL_CONT_MULT : cls === 'lbl-ocean' ? LABEL_OCEAN_MULT : 1 })
    }
    function buildLabels(fc: GeoFC) {
      const cont = new Map<string, { x: number; y: number; w: number }>()
      // 所有国家(含小岛国)都标名字,不再只取面积前 70;字号小、青绿色,背面半球自动隐藏
      for (const f of fc.features) { const p = f.properties; if (!p.name || /seven seas/i.test(p.continent || '')) continue; addLabel(p.name, p.cx, p.cy, 'lbl-country') }
      for (const f of fc.features) { const p = f.properties; if (!p.continent || /seven seas/i.test(p.continent)) continue; const c = cont.get(p.continent) ?? { x: 0, y: 0, w: 0 }; c.x += p.cx * p.area; c.y += p.cy * p.area; c.w += p.area; cont.set(p.continent, c) }
      cont.forEach((c, name) => addLabel(name.toUpperCase(), c.x / c.w, c.y / c.w, 'lbl-cont'))
      // 海洋注记(数据里没有逐个大洋名,硬编码主要大洋 + 大致经纬,粉色斜体)
      const OCEANS: [string, number, number][] = [
        ['Pacific Ocean', -150, 0], ['Pacific Ocean', 175, 10], ['Atlantic Ocean', -30, 5],
        ['Indian Ocean', 78, -28], ['Southern Ocean', 25, -62], ['Arctic Ocean', -40, 78],
      ]
      for (const [name, lng, lat] of OCEANS) addLabel(name, lng, lat, 'lbl-ocean')
    }
    // 加密点(带 iso):专辑越多的国家在每个原始格子周围补越多抖动点 → 更多封面坑位。白点和封面共用这套点。
    function densify(cents: Cent[], fc: GeoFC): Cent[] {
      const cellCnt = new Map<string, number>(); for (const c of cents) cellCnt.set(c.iso, (cellCnt.get(c.iso) ?? 0) + 1)
      const cov = new Map<string, number>(); for (const f of fc.features) cov.set(f.properties.iso, f.properties.covers ?? 0)
      const out: Cent[] = []
      for (const c of cents) { if (c.iso === 'AQ') continue; const k = Math.max(1, Math.min(MAX_K, Math.round((cov.get(c.iso) ?? 0) / (cellCnt.get(c.iso) ?? 1) / DENS_DIV))); out.push(c); for (let j = 1; j < k; j++) out.push({ iso: c.iso, lng: c.lng + (Math.random() - 0.5) * 0.75, lat: c.lat + (Math.random() - 0.5) * 0.75 }) }
      return out
    }
    function buildDots(pts: [number, number][]) {
      const n = pts.length, pos = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) { const v = ll2v(pts[i][0], pts[i][1], 1.004); pos[i * 3] = v[0]; pos[i * 3 + 1] = v[1]; pos[i * 3 + 2] = v[2] }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      const m = new THREE.ShaderMaterial({
        uniforms: { uSize: { value: 9.0 } }, transparent: true, depthWrite: false, depthTest: true,
        vertexShader: `uniform float uSize; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=uSize*(1.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
        fragmentShader: `void main(){ float d=length(gl_PointCoord-0.5); if(d>0.5) discard; float core=smoothstep(0.30,0.16,d); float glow=smoothstep(0.5,0.16,d)*0.45; gl_FragColor=vec4(1.0,1.0,1.0,max(core,glow)); }`,
      })
      const p = new THREE.Points(g, m); p.renderOrder = 2; scene.add(p)
    }
    // 国家边界「极光光幕」:每段边界沿径向(垂直地表)向外拉成竖直 ribbon,升到封面层之上 →
    // 封面盖住地表时各国轮廓仍浮在上面可见。底亮顶透 + 绿↔粉渐变 + 微流动,additive。
    function buildAurora(fc: GeoFC) {
      const R0 = 1.004, H = 0.05   // 墙底贴边界、径向升 H;远地球面那侧被不透明海洋球 depth 遮挡
      const pos: number[] = [], ay: number[] = []
      for (const f of fc.features) {
        if (f.properties.iso === 'AQ') continue
        const polys = (f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates]) as number[][][][]
        for (const poly of polys) for (const ring of poly) for (let i = 0; i + 1 < ring.length; i++) {
          const a = ring[i], b = ring[i + 1]
          const ba = ll2v(a[0], a[1], R0), bb = ll2v(b[0], b[1], R0), ta = ll2v(a[0], a[1], R0 + H), tb = ll2v(b[0], b[1], R0 + H)
          pos.push(ba[0], ba[1], ba[2], bb[0], bb[1], bb[2], tb[0], tb[1], tb[2], ba[0], ba[1], ba[2], tb[0], tb[1], tb[2], ta[0], ta[1], ta[2])
          ay.push(0, 0, 1, 0, 1, 1)
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('aY', new THREE.Float32BufferAttribute(ay, 1))
      const m = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        vertexShader: `attribute float aY; varying float vY; varying vec3 vP; void main(){ vY=aY; vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `varying float vY; varying vec3 vP; uniform float uTime;
          void main(){
            vec3 nrm = normalize(vP); vec3 vd = normalize(cameraPosition - vP);
            if (dot(nrm, vd) < 0.0) discard;                                            // 丢弃地球背面光幕(depthTest 已关,靠这个防穿透)
            float fade = 1.0 - vY; fade = fade * fade;                                  // 顶部淡出
            float lon = atan(-vP.z, vP.x);                                              // 经度 → 东西半球
            float t = 0.5 + 0.5 * sin(lon + uTime * 0.2);                               // 只按经度交替 + 随时间扫动(日出日落),南北同经度同色
            vec3 col = mix(vec3(0.30, 1.0, 0.55), vec3(0.99, 0.87, 0.65), t);           // 绿 ↔ 字体暖橙(#FDDEA5)
            float shimmer = 0.75 + 0.25 * sin(vP.x * 30.0 + vP.z * 30.0 + uTime * 2.5);        // 流动微闪
            gl_FragColor = vec4(col, fade * 0.4 * shimmer);
          }`,
      })
      const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 4; mesh.frustumCulled = false; mesh.visible = auroraOnRef.current; scene.add(mesh)
      auroraMatRef = m; auroraMeshRef.current = mesh
    }

    let raf = 0, disposed = false
    const clock = new THREE.Clock()
    const raycaster = new THREE.Raycaster(); const mouse = new THREE.Vector2()
    let onClickDom: ((e: MouseEvent) => void) | null = null
    let onDownDom: ((e: PointerEvent) => void) | null = null
    let downX = 0, downY = 0   // 记录按下位置:松手时位移过大 = 拖拽旋转,不当作点击搜索
    let stepFn: ((p: number, n: number) => void) | null = null
    let coverMatRef: THREE.ShaderMaterial | null = null
    let auroraMatRef: THREE.ShaderMaterial | null = null
    const _v = new THREE.Vector3(), _cam = new THREE.Vector3()

    function animate() {
      if (disposed) return
      raf = requestAnimationFrame(animate)
      if (sceneLayerEl && !sceneLayerEl.classList.contains('is-active')) return  // 地图页不可见 → 不渲染
      const now = clock.getElapsedTime()
      if (stepFn && coverMatRef) { coverMatRef.uniforms.uTime.value = now; stepFn(progressRef.current, now) }
      if (auroraMatRef) auroraMatRef.uniforms.uTime.value = now
      controls.update()
      const lblS = Math.max(LABEL_S_MIN, Math.min(LABEL_S_MAX, Math.pow(LABEL_REF_D / camera.position.length(), LABEL_POW)))
      _cam.copy(camera.position).normalize()
      for (const l of labels) { const vis = _v.copy(l.pos).normalize().dot(_cam) > 0.12; l.el.visible = vis; if (vis) l.span.style.transform = `scale(${lblS * l.mult})` }
      renderer.render(scene, camera); labelRenderer.render(scene, camera)
    }

    async function main() {
      setLoading('加载地图…')
      const [cents, countries] = await Promise.all([
        fetch(GRID_EA ? '/api/grids/centroids-ea' : '/api/grids/centroids').then((r) => r.json()),
        fetch('/api/countries/geojson').then((r) => r.json()),
      ])
      if (disposed) return
      const dense = densify(cents as Cent[], countries as GeoFC)   // 封面坑位用加密点(各国按发行量补抖动点 → 高产国封面更密)
      // 白点只用「未加密」的原始网格(均匀),避免点密度本身就泄露各国发行量、显得刻意;封面照旧按 dense 浮现
      buildLand(countries as GeoFC); buildLabels(countries as GeoFC)
      buildDots((cents as Cent[]).filter((c) => c.iso !== 'AQ').map((c) => [c.lng, c.lat] as [number, number]))
      buildAurora(countries as GeoFC)
      animate()                                    // 底图就绪 → 立即开转(封面后台加载)
      setLoading('加载封面…')

      type GenreMeta = { fine: string[]; bucket: string[]; fineBucket: number[] }
      type Cover = { texes: THREE.Texture[]; mbidUV: Map<string, [number, number, number]>; pool: Record<string, Album[]>; counts: Record<string, Record<string, number>>; cellUV: number; flatAlbums: Album[]; genre?: GenreMeta }

      // 方案 B:优先用后端预烤图集 → 只下 manifest + N 张图集 → 秒开(任何浏览器/重启后都缓存命中)
      async function loadBaked(): Promise<Cover | null> {
        type Man = { version: number; cell: number; atlas_px: number; grid_a: number; n_atlas: number; counts: Record<string, Record<string, number>>; pool: Record<string, [number, string, number?][]>; genreFine?: string[]; genreBucket?: string[]; fineBucket?: number[] }
        let man: Man
        try { const r = await fetch('/api/atlas/manifest.json'); if (!r.ok) return null; man = await r.json() } catch { return null }
        const cUV = man.cell / man.atlas_px, gridA = man.grid_a, perA = gridA * gridA
        const pool: Record<string, Album[]> = {}, mbidUV = new Map<string, [number, number, number]>(), flatAlbums: Album[] = []
        let k = 0   // manifest.pool 的遍历顺序 = 烤图时的格子顺序 → 据此还原 mbid→[图集,u,v]
        for (const iso of Object.keys(man.pool)) {
          const out: Album[] = []
          for (const [y, c, gc] of man.pool[iso]) {
            const g = Math.floor(k / perA), j = k % perA
            mbidUV.set(c, [g, (j % gridA) * cUV, Math.floor(j / gridA) * cUV])
            const a: Album = { y, c, iso, g: gc ?? -1 }; out.push(a); flatAlbums.push(a); k++
          }
          pool[iso] = out
        }
        const genre: GenreMeta | undefined = man.genreFine
          ? { fine: man.genreFine, bucket: man.genreBucket ?? [], fineBucket: man.fineBucket ?? [] } : undefined
        const texes: THREE.Texture[] = []
        for (let g = 0; g < man.n_atlas; g++) {
          setLoading(`加载预烤图集 ${g + 1}/${man.n_atlas}…`)
          const blob = await fetch(`/api/atlas/${g}.jpg?v=${man.version}`).then((r) => r.blob())   // ?v 让重烤后缓存失效
          const bmp = await createImageBitmap(blob)
          const t = new THREE.Texture(bmp); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.flipY = false; t.needsUpdate = true
          try { renderer.initTexture(t) } catch { /* 无 initTexture 则留给首帧惰性上传 */ }   // 关键:这一张立刻单独上传,不攒到 8 张一帧灌爆显存
          texes.push(t)
          await new Promise((r) => requestAnimationFrame(r))   // 让出一帧给 GPU/合成器喘息,避免连续上传触发 TDR
        }
        return { texes, mbidUV, pool, counts: man.counts, cellUV: cUV, flatAlbums, genre }
      }

      // 回退:未预烤时,实时拉全量封面在浏览器里拼图集(慢、占带宽)
      async function loadLive(): Promise<Cover> {
        const alb = await fetch(`/api/timeline/albums?per=${PER}`).then((r) => r.json())
        const counts: Record<string, Record<string, number>> = alb.counts
        const pool: Record<string, Album[]> = alb.pool ?? {}
        const chosen: string[] = [], mbidUV = new Map<string, [number, number, number]>(), flatAlbums: Album[] = []
        { const isoArrs = Object.values(pool); let ri = 0, added = true   // 轮转选,覆盖所有国家
          while (chosen.length < COVER_CAP && added) { added = false; for (const arr of isoArrs) { if (ri < arr.length) { const a = arr[ri]; chosen.push(a.c!); flatAlbums.push(a); added = true; if (chosen.length >= COVER_CAP) break } } ri++ } }
        const cellUV = CELL / ATLAS_PX, N_ATLAS = Math.max(1, Math.ceil(chosen.length / PER_ATLAS))
        for (let k = 0; k < chosen.length; k++) { const g = Math.floor(k / PER_ATLAS), j = k % PER_ATLAS; mbidUV.set(chosen[k], [g, (j % GRID_A) * cellUV, Math.floor(j / GRID_A) * cellUV]) }
        const ctxs: CanvasRenderingContext2D[] = [], canvases: HTMLCanvasElement[] = []
        for (let g = 0; g < N_ATLAS; g++) { const cv = document.createElement('canvas'); cv.width = cv.height = ATLAS_PX; const cx = cv.getContext('2d')!; cx.fillStyle = '#222'; cx.fillRect(0, 0, ATLAS_PX, ATLAS_PX); canvases.push(cv); ctxs.push(cx) }
        let loadedN = 0
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
                .finally(() => { active--; loadedN++; if (loadedN % 2000 === 0) setLoading(`加载封面 ${loadedN}/${chosen.length}…`); (idx >= chosen.length && active === 0) ? resolve() : pump() })
            }
          }
          pump()
        })
        const texes = canvases.map((cv) => { const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.flipY = false; try { renderer.initTexture(t) } catch { /* */ } return t })
        return { texes, mbidUV, pool, counts, cellUV, flatAlbums }
      }

      const cover = (await loadBaked()) ?? (await loadLive())
      if (disposed) return
      const { texes, mbidUV, pool, counts, cellUV, flatAlbums, genre } = cover
      onLoadedRef.current?.(flatAlbums)

      // ── 曲风:统计每个细分/粗桶的封面数,推给上层做下拉框 ──
      const gFine = genre?.fine ?? [], gBucket = genre?.bucket ?? [], gFineBucket = genre?.fineBucket ?? []
      if (genre) {
        const fineCount = new Array(gFine.length).fill(0)
        for (const a of flatAlbums) { const c = a.g ?? -1; if (c >= 0) fineCount[c]++ }
        const groups = gBucket.map((b, bi) => {
          const fines = gFine
            .map((name, fi) => ({ name, fi, count: fineCount[fi] }))
            .filter((x) => gFineBucket[x.fi] === bi && x.count > 0)
            .sort((a, b2) => b2.count - a.count)
            .map((x) => ({ name: x.name, count: x.count }))
          return { bucket: b, count: fines.reduce((s, f) => s + f.count, 0), fines }
        }).filter((g) => g.count > 0).sort((a, b2) => b2.count - a.count)
        onGenresRef.current?.(groups)
      }
      // 当前激活的曲风码集合(null=全部);由 applyGenreFilter 改写
      let activeCodes: Set<number> | null = null
      const codesFor = (value: string): Set<number> | null => {
        if (!value || value === 'all') return null
        if (value.startsWith('fine:')) { const i = gFine.indexOf(value.slice(5)); return new Set(i >= 0 ? [i] : []) }
        if (value.startsWith('bucket:')) { const bi = gBucket.indexOf(value.slice(7)); const s = new Set<number>(); gFineBucket.forEach((b, fi) => { if (b === bi) s.add(fi) }); return s }
        return null
      }
      const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); dummy.needsUpdate = true
      const samplers: Record<string, { value: THREE.Texture }> = {}
      for (let g = 0; g < N_ATLAS_MAX; g++) samplers['uA' + g] = { value: texes[g] ?? dummy }

      // 每格一个 instance(封面位用原始格子,未加密)
      const flatPos: [number, number, number][] = [], cellInstByIso = new Map<string, number[]>()
      for (const c of dense) { const i = flatPos.length; flatPos.push(ll2v(c.lng, c.lat, 1.006)); let a = cellInstByIso.get(c.iso); if (!a) { a = []; cellInstByIso.set(c.iso, a) } a.push(i) }
      cellInstByIso.forEach((a) => shuffle(a)); const COUNT = flatPos.length
      const instAlbum: (Album | undefined)[] = new Array(COUNT)

      // 曲风过滤:activeCodes 非空时只保留该曲风的封面(未知码 -1 在筛选时被排除)
      const buildPools = () => { const m = new Map<string, Map<number, Album[]>>(); for (const [iso, arr] of Object.entries(pool)) { const ym = new Map<number, Album[]>(); for (const a of arr) { if (!mbidUV.has(a.c!)) continue; if (activeCodes && !activeCodes.has(a.g ?? -1)) continue; let b = ym.get(a.y); if (!b) { b = []; ym.set(a.y, b) } b.push(a) } ym.forEach((b) => shuffle(b)); m.set(iso, ym) } return m }
      let poolByYear = buildPools()
      const prefixByIso = new Map<string, number[]>()
      const rebuildPrefix = () => { prefixByIso.clear(); cellInstByIso.forEach((_c, iso) => { const ym = poolByYear.get(iso), pre = new Array<number>(NUM_YEARS + 1); pre[0] = 0; for (let i = 0; i < NUM_YEARS; i++) { const yr = YEAR_START + i; pre[i + 1] = pre[i] + Math.min(counts[String(yr)]?.[iso] ?? 0, ym?.get(yr)?.length ?? 0) } prefixByIso.set(iso, pre) }) }
      rebuildPrefix()
      const pickAlbum = (iso: string, year: number): Album | undefined => { const ym = poolByYear.get(iso); if (!ym) return; let arr = ym.get(year); if (!arr?.length) { for (let y = year - 1; y >= YEAR_START; y--) { const a = ym.get(y); if (a?.length) { arr = a; break } } } if (!arr?.length) { for (let y = year + 1; y < YEAR_START + NUM_YEARS; y++) { const a = ym.get(y); if (a?.length) { arr = a; break } } } return arr?.length ? arr.pop() : undefined }

      const baseGeo = new THREE.PlaneGeometry(1, 1)
      const geo = new THREE.InstancedBufferGeometry(); geo.index = baseGeo.index; geo.attributes.position = baseGeo.attributes.position; geo.attributes.uv = baseGeo.attributes.uv; geo.instanceCount = COUNT
      const iPos = new Float32Array(COUNT * 3), iUV = new Float32Array(COUNT * 2), iBorn = new Float32Array(COUNT), iAtlas = new Float32Array(COUNT)
      for (let i = 0; i < COUNT; i++) { iPos[i * 3] = flatPos[i][0]; iPos[i * 3 + 1] = flatPos[i][1]; iPos[i * 3 + 2] = flatPos[i][2]; iBorn[i] = 1e9 }
      const aUV = new THREE.InstancedBufferAttribute(iUV, 2); aUV.setUsage(THREE.DynamicDrawUsage)
      const aBorn = new THREE.InstancedBufferAttribute(iBorn, 1); aBorn.setUsage(THREE.DynamicDrawUsage)
      const aAtlas = new THREE.InstancedBufferAttribute(iAtlas, 1); aAtlas.setUsage(THREE.DynamicDrawUsage)
      geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3)); geo.setAttribute('iUV', aUV); geo.setAttribute('iBorn', aBorn); geo.setAttribute('iAtlas', aAtlas)
      const coverMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uCell: { value: cellUV }, uSize: { value: SIZE }, ...samplers },
        transparent: true, depthTest: true, depthWrite: false,
        vertexShader: `uniform float uTime,uSize,uCell; attribute vec3 iPos; attribute vec2 iUV; attribute float iBorn; attribute float iAtlas; varying vec2 vUv; varying float vOp; varying float vAtlas;
          float eob(float x){ float c1=1.70158,c3=c1+1.0; float t=x-1.0; return 1.0+c3*t*t*t+c1*t*t; }
          void main(){ float age=uTime-iBorn; float t=clamp(age/0.65,0.0,1.0); float scale=age<0.0?0.0:max(0.0,eob(t)); vOp=age<0.0?0.0:clamp(age/0.4,0.0,1.0); vAtlas=iAtlas; vUv=iUV+vec2(uv.x,1.0-uv.y)*uCell; vec4 mv=modelViewMatrix*vec4(iPos,1.0); mv.xy+=position.xy*uSize*scale; gl_Position=projectionMatrix*mv; }`,
        fragmentShader: `uniform sampler2D uA0,uA1,uA2,uA3,uA4,uA5,uA6,uA7; varying vec2 vUv; varying float vOp; varying float vAtlas;
          void main(){ if(vOp<0.02) discard; int a=int(vAtlas+0.5); vec3 c;
            if(a==0)c=texture2D(uA0,vUv).rgb; else if(a==1)c=texture2D(uA1,vUv).rgb; else if(a==2)c=texture2D(uA2,vUv).rgb; else if(a==3)c=texture2D(uA3,vUv).rgb;
            else if(a==4)c=texture2D(uA4,vUv).rgb; else if(a==5)c=texture2D(uA5,vUv).rgb; else if(a==6)c=texture2D(uA6,vUv).rgb; else c=texture2D(uA7,vUv).rgb;
            gl_FragColor=vec4(c,vOp); }`,
      })
      const coverMesh = new THREE.Mesh(geo, coverMat); coverMesh.frustumCulled = false; coverMesh.renderOrder = 3; scene.add(coverMesh)

      const appeared = new Map<string, number>(); let lastP = 0, lastNow = 0
      const APPEAR_S = 0.65   // 封面出现动画时长;每格翻面间隔不应短于它,否则封面没冒出来就被覆盖
      const reset = () => { appeared.clear(); poolByYear = buildPools(); iBorn.fill(1e9); instAlbum.fill(undefined); aBorn.needsUpdate = true }
      const step = (p: number, now: number) => {
        if (p < lastP - 1e-6) reset()
        lastP = p
        if (!playingRef.current) { lastNow = now; return }   // 暂停:冻结翻面(时钟仍走,但不再覆盖已点亮封面)
        const dt = Math.min(0.1, Math.max(0, now - lastNow)); lastNow = now
        const t = p * NUM_YEARS, curYear = YEAR_START + Math.min(Math.floor(t), NUM_YEARS - 1); let dirty = false
        cellInstByIso.forEach((cells, iso) => {
          const prefix = prefixByIso.get(iso); if (!prefix) return
          const cap = cells.length, target = Math.round(cumOf(prefix, t)); let app = appeared.get(iso) ?? 0; if (target <= app) return
          // 限速:本帧最多翻 cap*dt/APPEAR 个格子 → 每格约 APPEAR 秒翻一次;密集国家(GB/JP)就稳定 churn 而非瞬间覆盖
          const end = Math.min(target, app + Math.max(1, Math.ceil(cap * dt / APPEAR_S)))
          for (; app < end; app++) { const inst = cells[app % cap]; const al = pickAlbum(iso, curYear); if (!al) continue; const uv = mbidUV.get(al.c!)!; iAtlas[inst] = uv[0]; iUV[inst * 2] = uv[1]; iUV[inst * 2 + 1] = uv[2]; iBorn[inst] = now; instAlbum[inst] = al; dirty = true }
          appeared.set(iso, app)
        })
        if (dirty) { aUV.needsUpdate = true; aBorn.needsUpdate = true; aAtlas.needsUpdate = true }
      }

      // 点击拾取:与地球相交 → 找最近的已点亮封面
      onDownDom = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY }
      renderer.domElement.addEventListener('pointerdown', onDownDom)
      onClickDom = (e: MouseEvent) => {
        if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return  // 拖拽旋转 → 不触发搜索
        const rect = renderer.domElement.getBoundingClientRect()
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1; mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
        raycaster.setFromCamera(mouse, camera)
        const hit = raycaster.intersectObject(oceanMesh, false); if (!hit.length) return
        const p = hit[0].point; let best = -1, bd = 0.05
        for (let i = 0; i < COUNT; i++) { if (iBorn[i] > 1e8) continue; const dx = iPos[i * 3] - p.x, dy = iPos[i * 3 + 1] - p.y, dz = iPos[i * 3 + 2] - p.z; const d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = i } }
        if (best >= 0 && instAlbum[best]) onClickRef.current?.(instAlbum[best]!)
      }
      renderer.domElement.addEventListener('click', onClickDom)

      // ── 切换曲风:重建封面池/前缀 → 清空已点亮 → 按当前进度立即重新填充(带出现动画) ──
      const fillGenreNow = (now: number) => {
        const t = progressRef.current * NUM_YEARS, curYear = YEAR_START + Math.min(Math.floor(t), NUM_YEARS - 1); let dirty = false
        cellInstByIso.forEach((cells, iso) => {
          const prefix = prefixByIso.get(iso); if (!prefix) return
          const cap = cells.length, target = Math.round(cumOf(prefix, t)); let app = 0
          for (; app < target; app++) { const inst = cells[app % cap]; const al = pickAlbum(iso, curYear); if (!al) continue; const uv = mbidUV.get(al.c!)!; iAtlas[inst] = uv[0]; iUV[inst * 2] = uv[1]; iUV[inst * 2 + 1] = uv[2]; iBorn[inst] = now; instAlbum[inst] = al; dirty = true }
          appeared.set(iso, app)
        })
        if (dirty) { aUV.needsUpdate = true; aBorn.needsUpdate = true; aAtlas.needsUpdate = true }
      }
      const applyGenreFilter = (value: string) => {
        activeCodes = codesFor(value)
        poolByYear = buildPools()
        rebuildPrefix()
        appeared.clear(); iBorn.fill(1e9); instAlbum.fill(undefined)
        fillGenreNow(clock.getElapsedTime())
      }
      applyGenreRef.current = applyGenreFilter
      if (genreFilterRef.current && genreFilterRef.current !== 'all') applyGenreFilter(genreFilterRef.current)

      coverMatRef = coverMat; stepFn = step   // 封面就绪 → animate 开始驱动出现/替换
      setLoading(null)
    }
    main()

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      if (onClickDom) renderer.domElement.removeEventListener('click', onClickDom)
      if (onDownDom) renderer.domElement.removeEventListener('pointerdown', onDownDom)
      removeEventListener('resize', onResize)
      controls.dispose(); renderer.dispose()
      container.removeChild(renderer.domElement); container.removeChild(labelRenderer.domElement)
    }
  }, [])

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
      {loading && <div className="globe-loading"><span className="gl-spin" />{loading}</div>}
    </div>
  )
}

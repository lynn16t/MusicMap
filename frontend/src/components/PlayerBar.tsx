import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Speed, GroupRec } from './MapScene'
import type { GenreGroup } from './MapGlobe3D'

const SPEEDS: { key: Speed; label: string }[] = [
  { key: 'slow', label: 'SLOW' },
  { key: 'fast', label: 'FAST' },
  { key: 'weird', label: 'WEIRD' },
]

type Props = {
  cover?: string | null
  title?: string
  artist?: string
  active?: boolean        // 是否已选中某专辑(Spotify 联动中)
  isPlaying?: boolean
  position?: number       // ms
  duration?: number       // ms
  onToggle?: () => void
  onPrev?: () => void
  onNext?: () => void
  auroraOn?: boolean
  onAuroraToggle?: () => void
  speed?: Speed | null            // 播放速度(原顶栏的 SLOW/FAST/WEIRD,已移到这里)
  onSelectSpeed?: (s: Speed) => void
  recommender?: { name: string; country?: string; url?: string } | null  // 推荐人:选了组员推荐后才出现
  recommendations?: GroupRec[]              // 圆形头像菜单:组员推荐列表
  onRecommend?: (r: GroupRec) => void       // 选中某条推荐
  genre?: string                            // 当前曲风:'all'|'bucket:Rock'|'fine:rock'
  genreGroups?: GenreGroup[]                // 曲风分级清单(粗桶→细分)
  onGenreChange?: (v: string) => void
}

const fmt = (ms?: number) => {
  if (!ms || ms < 0 || !isFinite(ms)) return '0:00'
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function PlayerBar(
  { cover, title, artist, active, isPlaying, position, duration, onToggle, onPrev, onNext, auroraOn, onAuroraToggle, speed, onSelectSpeed, recommender, recommendations, onRecommend, genre = 'all', genreGroups = [], onGenreChange }: Props,
) {
  const pct = duration ? Math.min((position ?? 0) / duration * 100, 100) : 0
  const pickRandomRec = () => {
    if (!recommendations?.length) return
    onRecommend?.(recommendations[(Math.random() * recommendations.length) | 0])
  }
  const [genreOpen, setGenreOpen] = useState(false)
  const [hoverBucket, setHoverBucket] = useState<string | null>(null)
  const genreDDRef = useRef<HTMLDivElement>(null)
  const finesRef = useRef<HTMLDivElement>(null)
  const pickGenre = (v: string) => { onGenreChange?.(v); setGenreOpen(false); setHoverBucket(null) }
  // 细分浮层:顶部与所悬停大类对齐(不再从底部长出),并夹在视口内 → 长列表顶部不被遮、低位不溢出
  useLayoutEffect(() => {
    const fly = finesRef.current
    if (!hoverBucket || !fly) return
    const btn = fly.closest('.gm-row')?.querySelector('.gm-bucket') as HTMLElement | null
    if (!btn) return
    const br = btn.getBoundingClientRect()
    const margin = 12, vh = window.innerHeight
    fly.style.maxHeight = ''
    const w = fly.offsetWidth || 200
    const h = Math.min(fly.scrollHeight + 2, vh - margin * 2)
    let top = br.top - 5                               // 细分顶部 ≈ 大类顶部
    if (top + h > vh - margin) top = vh - margin - h   // 溢出底部 → 上移
    if (top < margin) top = margin                     // 溢出顶部 → 下压
    fly.style.position = 'fixed'
    fly.style.top = `${Math.round(top)}px`
    fly.style.left = `${Math.round(br.left - w - 6)}px`
    fly.style.right = 'auto'; fly.style.bottom = 'auto'
    fly.style.maxHeight = `${Math.round(h)}px`
  }, [hoverBucket])
  // 点击外部才关闭(悬停只负责展开细分)→ 鼠标往上移到选项不会消失
  useEffect(() => {
    if (!genreOpen) return
    const onDown = (e: PointerEvent) => {
      if (genreDDRef.current && !genreDDRef.current.contains(e.target as Node)) { setGenreOpen(false); setHoverBucket(null) }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [genreOpen])
  const genreLabel = !genre || genre === 'all' ? '全部曲风'
    : genre.startsWith('bucket:') ? genre.slice(7)
      : genre.startsWith('fine:') ? genre.slice(5) : '全部曲风'
  const dispTitle = active ? (title ?? '加载中…') : 'You Can Be A Star'
  const dispSub = active ? (artist ?? '') : 'Luther Davis Group — You Can Be A Star / To Be Free'

  return (
    <footer className="player">
      {/* 封面 + 黑胶;中心红点换成当前专辑封面 */}
      <div className="cover">
        <div className="label">LIFE TIME<br />RECORDS</div>
        <div className="vinyl">
          {cover && <img className="disc-cover" src={cover} alt="" />}
        </div>
      </div>

      <div className="center">
        <div className="mini-actions">
          <button className="mini" title="喜欢"><svg className="icon" viewBox="0 0 24 24" fill="#fff"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" /></svg></button>
          <button className="mini" title="分享"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2}><circle cx="6" cy="12" r="2.4" /><circle cx="17" cy="6" r="2.4" /><circle cx="17" cy="18" r="2.4" /><path d="M8.2 11l6.6-3.6M8.2 13l6.6 3.6" /></svg></button>
          <button className="mini" title="加入歌单"><svg className="icon" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2}><path d="M4 7h12M4 12h12M4 17h8M18 14v6M15 17h6" /></svg></button>
        </div>

        <div className="transport">
          <button className="tbtn" title="上一张" onClick={onPrev}>
            <svg className="icon" viewBox="0 0 24 24" fill="#fff"><path d="M19 5l-9 7 9 7z" /><rect x="5" y="5" width="3" height="14" /></svg>
          </button>
          <button className="tbtn play" title={isPlaying ? '暂停' : '播放'} onClick={onToggle}>
            {isPlaying
              ? <svg className="icon" viewBox="0 0 24 24" fill="#fff"><rect x="7" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" /></svg>
              : <svg className="icon" viewBox="0 0 24 24" fill="#fff"><path d="M7 5l12 7-12 7z" /></svg>}
          </button>
          <button className="tbtn" title="下一张" onClick={onNext}>
            <svg className="icon" viewBox="0 0 24 24" fill="#fff"><path d="M5 5l9 7-9 7z" /><rect x="16" y="5" width="3" height="14" /></svg>
          </button>
        </div>

        <div className="track">
          <div className="title">{dispTitle}</div>
          <div className="sub">{dispSub}</div>
          <div className="pbar"><div className="pfill" style={{ width: `${pct}%` }} /></div>
          <div className="times"><span>{active ? fmt(position) : '00:00'}</span><span>{active ? fmt(duration) : '04:38'}</span></div>
        </div>

        <div className="volume">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2}><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16 9c1.5 1.5 1.5 4.5 0 6" /></svg>
          <input type="range" min={0} max={100} defaultValue={60} />
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2}><path d="M4 8h10M18 8h2M4 16h2M10 16h10" /><circle cx="16" cy="8" r="2" /><circle cx="8" cy="16" r="2" /></svg>
        </div>
      </div>

      <div className="discovered">
        <button
          className="avatar"
          title="组员推荐(点我随机来一首)"
          onClick={pickRandomRec}
        >
          <svg className="icon" viewBox="0 0 24 24" fill="#fff"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c0-3.3 3.6-5 8-5s8 1.7 8 5z" /></svg>
        </button>
        <div className="meta">
          <div className="k">RECOMMENDED BY</div>
          <div className="name">{recommender?.name ?? ''}</div>
          <div className="country">{recommender?.country ?? ''}</div>
          {recommender?.url
            ? <a href={recommender.url} target="_blank" rel="noreferrer">{recommender.url}</a>
            : <a href="#" onClick={(e) => e.preventDefault()}>&nbsp;</a>}
        </div>
        <div className="ctrl-stack">
          {/* 上排:曲风分级下拉(点开 → 悬停粗桶 → 右侧浮出细分,可停留滚动) */}
          <div className="genre-dd" ref={genreDDRef}>
            <button className={`genre-trigger${genreOpen ? ' open' : ''}`} title="按曲风筛选地图" onClick={() => setGenreOpen((o) => !o)}>
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M4 7h7M15 7h5M4 12h11M19 12h1M4 17h3M11 17h9" />
                <circle cx="13" cy="7" r="2" /><circle cx="17" cy="12" r="2" /><circle cx="9" cy="17" r="2" />
              </svg>
              <span className="gt-label">{genreLabel}</span>
            </button>
            {genreOpen && genreGroups.length > 0 && (
              <div className="genre-menu">
                <button className={`gm-bucket${(!genre || genre === 'all') ? ' on' : ''}`} onMouseEnter={() => setHoverBucket(null)} onClick={() => pickGenre('all')}>全部曲风</button>
                {genreGroups.map((g) => (
                  <div className="gm-row" key={g.bucket} onMouseEnter={() => setHoverBucket(g.bucket)}>
                    <button className={`gm-bucket${genre === `bucket:${g.bucket}` ? ' on' : ''}`} onClick={() => pickGenre(`bucket:${g.bucket}`)}>
                      <span className="gm-arrow">‹</span><span className="gm-name">{g.bucket}</span><span className="gm-cnt">{g.count}</span>
                    </button>
                    {hoverBucket === g.bucket && (
                      <div className="gm-fines" ref={finesRef}>
                        <button className="gm-fine gm-head" onClick={() => pickGenre(`bucket:${g.bucket}`)}>{g.bucket} · 全部 ({g.count})</button>
                        {g.fines.map((f) => (
                          <button key={f.name} className={`gm-fine${genre === `fine:${f.name}` ? ' on' : ''}`} onClick={() => pickGenre(`fine:${f.name}`)}>
                            <span className="gm-name">{f.name}</span><span className="gm-cnt">{f.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* 下排:速度 + 极光 */}
          <div className="ctrl-row">
            <div className="speed-mini" title="播放速度">
              {SPEEDS.map(({ key, label }) => (
                <button key={key} className={`sdot${speed === key ? ' on' : ''}`} title={label} onClick={() => onSelectSpeed?.(key)}>
                  <span className="lens" /><span className="slabel">{label}</span>
                </button>
              ))}
            </div>
            <button className={`pill-add aurora-toggle${auroraOn ? ' on' : ''}`} title={auroraOn ? '极光:开(点击关闭)' : '极光:关(点击开启)'} onClick={onAuroraToggle}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M5 16c2-5 4-7 7-7s5 2 7 7" />
                <path d="M7 17c1.5-3.5 3-5 5-5s3.5 1.5 5 5" opacity="0.65" />
                <path d="M12 4v2M9.5 5l.6 1.2M14.5 5l-.6 1.2" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}

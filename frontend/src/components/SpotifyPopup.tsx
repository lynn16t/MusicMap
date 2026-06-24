import { useEffect, useRef, useState } from 'react'
import type { Album, SpotifyHit } from '../types'
import { loadSpotifyApi, type SpotifyController } from '../spotifyApi'

type Props = {
  album: Album
  onClose: () => void
  onPrev: () => void
  onNext: () => void
  onResolved: (hit: SpotifyHit) => void
  onController: (c: SpotifyController | null) => void
  onPlayback: (d: import('../spotifyApi').PlaybackData) => void
}

export default function SpotifyPopup(
  { album, onClose, onPrev, onNext, onResolved, onController, onPlayback }: Props,
) {
  const [hit, setHit] = useState<SpotifyHit | null>(null)
  const [loading, setLoading] = useState(true)
  const hostRef = useRef<HTMLDivElement>(null)   // React 只管这个外壳,永不更新它
  const ctrlRef = useRef<SpotifyController | null>(null)
  const cbRef = useRef({ onResolved, onController, onPlayback })
  cbRef.current = { onResolved, onController, onPlayback }

  // 专辑变化 → 实时搜 Spotify
  useEffect(() => {
    let cancelled = false
    setLoading(true); setHit(null)
    const url = `/api/spotify/search?artist=${encodeURIComponent(album.a ?? '')}&title=${encodeURIComponent(album.t ?? '')}`
    fetch(url).then((r) => r.json()).then((h: SpotifyHit) => {
      if (cancelled) return
      setHit(h); setLoading(false); cbRef.current.onResolved(h)
    }).catch(() => { if (!cancelled) { setHit({ ok: false, reason: 'error' }); setLoading(false) } })
    return () => { cancelled = true }
  }, [album])

  // 拿到 id → 建/换嵌入播放器。用原生 DOM,React 不碰 iframe(避免卸载时崩溃)
  useEffect(() => {
    const id = hit?.ok ? hit.id : undefined
    if (!id || !hostRef.current) return
    const uri = `spotify:album:${id}`
    let active = true
    if (ctrlRef.current) { ctrlRef.current.loadUri(uri); return }
    loadSpotifyApi().then((API) => {
      if (!active || !hostRef.current || ctrlRef.current) return
      const inner = document.createElement('div') // 给 Spotify 替换的占位(非 React 管理)
      hostRef.current.appendChild(inner)
      API.createController(inner, { uri, width: '100%', height: 380 }, (ctrl) => {
        ctrlRef.current = ctrl
        cbRef.current.onController(ctrl)
        ctrl.addListener('playback_update', (e) => cbRef.current.onPlayback(e.data))
      })
    })
    return () => { active = false }
  }, [hit?.ok, hit?.id])

  // 卸载:销毁 controller(iframe 在外壳里,随外壳一起被 React 安全移除)
  useEffect(() => () => {
    try { ctrlRef.current?.destroy() } catch { /* ignore */ }
    ctrlRef.current = null
    cbRef.current.onController(null)
  }, [])

  return (
    <div className="spotify-pop">
      <div className="sp-head">
        <button className="sp-nav" title="上一张" onClick={onPrev}>‹</button>
        <div className="sp-title">
          <b>{album.t}</b>
          <span>{album.a}{album.y ? ` · ${album.y}` : ''}</span>
        </div>
        <button className="sp-nav" title="下一张" onClick={onNext}>›</button>
        <button className="sp-close" title="关闭" onClick={onClose}>✕</button>
      </div>

      {loading && <div className="sp-msg">在 Spotify 搜索…</div>}
      {!loading && hit && !hit.ok && (
        <div className="sp-msg">没找到对应的 Spotify 专辑<br /><small>({hit.reason})</small></div>
      )}
      <div ref={hostRef} className="sp-embed" />
    </div>
  )
}

// 地图页(scroll story 第 2 页):原 App.tsx 的地图 + 时间轴 + 播放器整体,原样搬进来。
import { useCallback, useRef, useState } from 'react'
import Stars from './Stars'
import MapGlobe3D, { type GenreGroup } from './MapGlobe3D'
import EsriTimeline from './EsriTimeline'
import PlayerBar from './PlayerBar'
import SpotifyPopup from './SpotifyPopup'
import ErrorBoundary from './ErrorBoundary'
import { useTimeline } from '../hooks/useTimeline'
import type { Album } from '../types'
import type { SpotifyController, PlaybackData } from '../spotifyApi'

export type Speed = 'slow' | 'fast' | 'weird'
const SPEED_MS: Record<Speed, number> = {
  slow: 360000,  // 6 分钟(慢)
  fast: 180000,  // 3 分钟(快)
  weird: 30000,  // 30 秒
}

// 组员推荐:点播放器里那个圆形头像标签 → 弹出五选一,选中即用 title/artist 走 Spotify 搜索
export type GroupRec = { person: string; title: string; artist: string }
// title/artist 用「在 /api/spotify/search 实测能命中」的写法(后端匹配较严):
// 蔡徐坤→艺名 KUN;宇多田光→罗马名 Utada Hikaru + Bad Mode(中日文名都 no_match)
const GROUP_RECS: GroupRec[] = [
  { person: '贾依依', title: '情人', artist: 'KUN' },
  { person: '葛晴', title: 'The Dark Side of the Moon', artist: 'Pink Floyd' },
  { person: '朱曼丽', title: 'How to Be a Human Being', artist: 'Glass Animals' },
  { person: '刘艺童', title: 'Bad Mode', artist: 'Utada Hikaru' },
  { person: '张书铭', title: 'Hue', artist: 'Mili' },
]

export default function MapScene({ onMapLoading }: { onMapLoading?: (m: string | null) => void } = {}) {
  const { progress, playing, play, pause, reset, setDuration } = useTimeline(SPEED_MS.slow)
  const [speed, setSpeed] = useState<Speed | null>(null)
  const [resetSignal, setResetSignal] = useState(0)
  const [auroraOn, setAuroraOn] = useState(true)   // 国家边界极光开关(只对 three 版生效)
  const [genre, setGenre] = useState('all')        // 曲风筛选:'all' | 'bucket:Rock' | 'fine:rock'
  const [genreGroups, setGenreGroups] = useState<GenreGroup[]>([])

  // Spotify 播放器联动
  const [clickedAlbum, setClickedAlbum] = useState<Album | null>(null)
  const [recommender, setRecommender] = useState<{ name: string; country?: string; url?: string } | null>(null)
  const [playback, setPlayback] = useState<PlaybackData>({ isPaused: true, position: 0, duration: 0 })
  const controllerRef = useRef<SpotifyController | null>(null)
  const albumsRef = useRef<Album[]>([])

  const selectSpeed = (s: Speed) => {
    // 速度键只切换播放速度,不控制播放/暂停(那是时间轴播放键的事);播放中切速度立即生效
    setSpeed(s); setDuration(SPEED_MS[s])
  }
  const togglePlay = () => {
    if (playing) { pause(); return }
    if (!speed) { setSpeed('slow'); setDuration(SPEED_MS.slow) }
    play()
  }
  const doReset = () => { reset(); setSpeed(null); setResetSignal((n) => n + 1) }

  const onResolved = useCallback(() => {}, []) // Spotify 解析结果不再驱动播放栏(改显示原专辑信息)
  const onController = useCallback((c: SpotifyController | null) => { controllerRef.current = c }, [])
  const onPlayback = useCallback((d: PlaybackData) => { setPlayback(d) }, [])
  // 全量模式 pool 只带 {y,c},点击/切换专辑时若缺标题/艺术家,先按 mbid 拉一次元数据再补上
  const selectAlbum = useCallback(async (a: Album | null) => {
    if (a && a.c && (a.t === undefined || a.a === undefined)) {
      try { const m = await fetch(`/api/album/${a.c}`).then((r) => r.json()); a = { ...a, t: m.t, a: m.a } } catch { /* 取不到就用空标题 */ }
    }
    setClickedAlbum(a)
  }, [])
  const randomAlbum = () => {
    const a = albumsRef.current
    return a.length ? a[(Math.random() * a.length) | 0] : null
  }
  // 普通点封面:清掉推荐人名,正常播放点中的专辑
  const onCoverClick = useCallback((a: Album | null) => {
    setRecommender(null); selectAlbum(a)
  }, [selectAlbum])
  // 从圆形头像菜单选了某位组员的推荐 → 显示他名字 + 复用点封面搜索播他那张
  const onRecommend = useCallback((r: GroupRec) => {
    setRecommender({ name: r.person, country: '组员推荐' })
    selectAlbum({ t: r.title, a: r.artist, y: 0 })
  }, [selectAlbum])
  const closePopup = () => {
    setClickedAlbum(null)
    setRecommender(null)
    setPlayback({ isPaused: true, position: 0, duration: 0 })
  }

  return (
    <>
      <Stars />
      <div id="glow" />
      <MapGlobe3D
        progress={progress} playing={playing} resetSignal={resetSignal} auroraOn={auroraOn}
        onCoverClick={onCoverClick}
        onAlbumsLoaded={(list) => { albumsRef.current = list }}
        onLoadingChange={onMapLoading}
        genreFilter={genre}
        onGenresLoaded={setGenreGroups}
      />
      <EsriTimeline progress={progress} playing={playing} onToggle={togglePlay} onReset={doReset} />
      <PlayerBar
        cover={clickedAlbum?.c ? `/api/covers/${clickedAlbum.c}` : null}
        title={clickedAlbum?.t}
        artist={clickedAlbum?.a}
        active={!!clickedAlbum}
        isPlaying={!playback.isPaused}
        position={playback.position}
        duration={playback.duration}
        onToggle={() => controllerRef.current?.togglePlay()}
        onNext={() => onCoverClick(randomAlbum())}
        onPrev={() => onCoverClick(randomAlbum())}
        auroraOn={auroraOn}
        onAuroraToggle={() => setAuroraOn((v) => !v)}
        speed={speed}
        onSelectSpeed={selectSpeed}
        recommender={recommender}
        recommendations={GROUP_RECS}
        onRecommend={onRecommend}
        genre={genre}
        genreGroups={genreGroups}
        onGenreChange={setGenre}
      />

      {clickedAlbum && (
        <ErrorBoundary onError={closePopup}>
          <SpotifyPopup
            album={clickedAlbum}
            onClose={closePopup}
            onPrev={() => onCoverClick(randomAlbum())}
            onNext={() => onCoverClick(randomAlbum())}
            onResolved={onResolved}
            onController={onController}
            onPlayback={onPlayback}
          />
        </ErrorBoundary>
      )}
    </>
  )
}

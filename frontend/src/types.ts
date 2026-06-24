// 一张专辑(来自后端 pool):t=标题, a=艺人, y=年份, c=封面 mbid(/api/covers/{c})
// 全量模式下 pool 只回 {y,c},t/a 在点击时用 /api/album/{c} 解析后补上,故可选。
export type Album = { t?: string; a?: string; y: number; c?: string; iso?: string; g?: number }

// Spotify 实时搜索结果
export type SpotifyHit = {
  ok: boolean
  reason?: string
  id?: string
  name?: string
  artist?: string
  image?: string | null
  url?: string
}

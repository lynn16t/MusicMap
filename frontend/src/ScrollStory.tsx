// scroll story 外壳:复刻原 scroll-story-demo/index.html 的结构,
// 但场景层从 4 个增到 5 个 —— 在场景 1、2 之间插入「地图页」(data-layer="1"),由 React 渲染 MapScene。
// 其余 4 层留空,交给 initScrollStory()(原 main.js)填充与驱动动画。
import { useEffect, useState } from 'react'
import MapScene from './components/MapScene'
import { initScrollStory } from './scrollstory/scrollStory.js'
import './scrollstory/scrollStory.css'

const STORY_SAMPLE_N = 300       // 第 3-4 页:按年份比例 + 中国保底
const AGE_SAMPLE_N = 300         // 第 5 页:按年龄组比例 + 中国保底

type YearRow = { c: string; y: number; t: string; a: string; am: string; iso: string }
type AgeRow = { c: string; y: number; t: string; a: string; am: string; age: number; bin: string; iso: string }
type AgeArtist = { id: string; am: string; a: string; age: number; bin: string; feat: boolean; group: string | null }

export default function ScrollStory() {
  // 地图图集加载状态(MapScene 一直挂载,所以一进站就在第 1 页后台加载);冒泡到这里全局显示
  const [mapLoading, setMapLoading] = useState<string | null>('地图加载中…')
  useEffect(() => {
    let destroy = () => {}
    let cancelled = false
    Promise.all([
      fetch(`/api/story/sample?n=${STORY_SAMPLE_N}`).then((r) => r.json()),
      fetch(`/api/story/age-sample?n=${AGE_SAMPLE_N}&_=${Date.now()}`).then((r) => r.json()),
    ])
      .then(([s, ag]) => {
        if (cancelled) return
        // 第 3-4 页:专辑封面(按年份)
        const albums = (s.albums || []).map((x: YearRow) => ({
          id: x.c, title: x.t, artist: x.a, year: x.y, iso: x.iso,
          artistMbid: x.am, image: `/api/covers/${x.c}`,
        }))
        // 第 5 页上排:专辑封面(按发行时年龄)
        const ageAlbums = (ag.albums || []).map((x: AgeRow) => ({
          id: x.c, title: x.t, artist: x.a, year: x.y, age: x.age, ageBin: x.bin,
          artistMbid: x.am, image: `/api/covers/${x.c}`,
        }))
        // 第 5 页下排:艺术家头像。featured = 跨年龄段作者(发光边框 + 可点击金线串联),group = 艺术家mbid
        const artists = (ag.artists || []).map((x: AgeArtist) => ({
          id: x.id, name: x.a, age: x.age, ageBin: x.bin, artistMbid: x.am,
          image: `/api/artists/${x.am}`, featured: x.feat, group: x.group,
        }))
        destroy = initScrollStory({ albums, ageAlbums, artists, yearCounts: s.yearCounts || {} })
      })
      .catch(() => {
        if (!cancelled) destroy = initScrollStory({ albums: [], ageAlbums: [], artists: [], yearCounts: {} })
      })
    return () => { cancelled = true; destroy() }
  }, [])

  return (
    <main className="story-container" id="story">
      <div className="sticky-stage">
        {/* 1-5 章节导航条(顶栏)。地图页也用它,不再有 RADIO 栏 */}
        <nav className="chapter-rail" aria-label="Story scenes" data-rail></nav>
        <div className="scene-stage" data-stage>
          <section className="scene-layer is-active" data-layer="0" aria-label="Scene 1"></section>
          {/* 第 2 页:地图。React 拥有此层 DOM,scroll story 仅切换 is-active 类 */}
          <section className="scene-layer scene-layer--map" data-layer="1" aria-label="Scene 2 · Map">
            <MapScene onMapLoading={setMapLoading} />
          </section>
          <section className="scene-layer" data-layer="2" aria-label="Scene 3"></section>
          <section className="scene-layer" data-layer="3" aria-label="Scene 4"></section>
          <section className="scene-layer" data-layer="4" aria-label="Scene 5"></section>
        </div>
      </div>

      <div className="scroll-steps" data-steps aria-hidden="true"></div>

      {/* 全局地图加载提示:渲染在场景层之外,故第 1 页也可见;加载完(null)自动消失 */}
      {mapLoading && (
        <div className="map-loading-badge"><span className="mlb-spin" />{mapLoading}</div>
      )}
    </main>
  )
}

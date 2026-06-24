// Spotify Embed IFrame API:无需登录/Premium,可从页面控制嵌入播放器(播放/暂停/seek)
// 并接收播放进度事件。文档:https://developer.spotify.com/documentation/embeds/references/iframe-api

export type SpotifyController = {
  loadUri: (uri: string) => void
  play: () => void
  pause: () => void
  togglePlay: () => void
  resume: () => void
  seek: (seconds: number) => void
  destroy: () => void
  addListener: (event: string, cb: (e: { data: PlaybackData }) => void) => void
}
export type PlaybackData = {
  isPaused: boolean
  isBuffering?: boolean
  duration: number   // 毫秒
  position: number   // 毫秒
}
type IFrameAPI = {
  createController: (
    el: HTMLElement,
    opts: { uri: string; width?: string | number; height?: string | number },
    cb: (controller: SpotifyController) => void,
  ) => void
}

let apiPromise: Promise<IFrameAPI> | null = null

export function loadSpotifyApi(): Promise<IFrameAPI> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve) => {
    const w = window as unknown as {
      SpotifyIframeApi?: IFrameAPI
      onSpotifyIframeApiReady?: (api: IFrameAPI) => void
    }
    if (w.SpotifyIframeApi) { resolve(w.SpotifyIframeApi); return }
    w.onSpotifyIframeApiReady = (api) => { w.SpotifyIframeApi = api; resolve(api) }
    const s = document.createElement('script')
    s.src = 'https://open.spotify.com/embed/iframe-api/v1'
    s.async = true
    document.body.appendChild(s)
  })
  return apiPromise
}

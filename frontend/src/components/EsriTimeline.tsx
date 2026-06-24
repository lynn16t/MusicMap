const YEAR_START = 2011
const YEAR_END = 2025

// 刻度年:2011 起步、2025 收尾。2011→2025 共 15 年,不能被 5 整除,故显式列出让首尾对齐两端。
const YEARS = [2011, 2015, 2020, 2025]
const pctOf = (y: number) => ((y - YEAR_START) / (YEAR_END - YEAR_START)) * 100

const PlayIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="#111"><path d="M6 4l14 8-14 8z" /></svg>
)
const PauseIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="#111">
    <rect x="6" y="5" width="4" height="14" /><rect x="14" y="5" width="4" height="14" />
  </svg>
)

type Props = {
  progress: number       // 0~1,由 App 的统一时钟驱动
  playing: boolean
  onToggle: () => void
  onReset: () => void
}

export default function EsriTimeline({ progress, playing, onToggle, onReset }: Props) {
  const curYear = Math.round(YEAR_START + progress * (YEAR_END - YEAR_START))
  const pct = `${(progress * 100).toFixed(2)}%`

  return (
    <div className="esri">
      <div className="row">
        <div className="ctrls">
          <button className="ec" title={playing ? '暂停' : '播放'} onClick={onToggle}>
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button className="ec" title="复原(回到最初)" onClick={onReset}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#111" strokeWidth={2.5}
              strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.9M3 4v4h4" />
            </svg>
          </button>
        </div>

        <div className="timeline">
          <div className="vlines">
            {YEARS.map((y) => <i key={y} style={{ left: `${pctOf(y)}%` }} />)}
          </div>
          <div className="track-wrap">
            <div className="rail" />
            <div className="fill" style={{ width: pct }} />
            <div className="head" style={{ left: pct }} />
          </div>
          <div className="ticks">
            {YEARS.map((y, i) => {
              const edge = i === 0 ? 'first' : i === YEARS.length - 1 ? 'last' : ''
              const cls = [edge, y === curYear ? 'cur' : ''].filter(Boolean).join(' ')
              return (
                <span key={y} className={cls} style={{ left: `${pctOf(y)}%` }}>{y}</span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

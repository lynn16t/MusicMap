// 顶栏只保留 RADIO 标志;速度键(SLOW/FAST/WEIRD)已移到播放器栏极光开关旁。
export default function TopBar() {
  return (
    <header className="topbar">
      <div className="logo">
        <b>RADIO</b>
        <span className="dots"><i /><i /><i /><i /><i /></span>
      </div>
    </header>
  )
}

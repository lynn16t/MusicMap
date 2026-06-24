import { useEffect, useRef } from 'react'

// 全屏星空(canvas),垫在地图之下;地球外太空透明 → 透出星星
export default function Stars() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const draw = () => {
      const w = (cv.width = window.innerWidth)
      const h = (cv.height = window.innerHeight)
      ctx.clearRect(0, 0, w, h)
      const n = Math.round((w * h) / 3200)
      for (let i = 0; i < n; i++) {
        const r = Math.random() * 1.2 + 0.2
        ctx.globalAlpha = Math.random() * 0.7 + 0.3
        ctx.fillStyle = '#fff'
        ctx.beginPath()
        ctx.arc(Math.random() * w, Math.random() * h, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }
    draw()
    window.addEventListener('resize', draw)
    return () => window.removeEventListener('resize', draw)
  }, [])
  return <canvas ref={ref} id="stars" />
}

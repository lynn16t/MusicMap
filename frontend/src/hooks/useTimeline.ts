import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 动画时钟:progress 0→1。
 * - play()/pause():播放/暂停(暂停保留进度,再 play 续上)
 * - reset():回到 0、停止
 * - setDuration(ms):变速,维持当前进度按新时长续算(支持播放中切速度)
 */
export function useTimeline(initialDuration: number) {
  const [progress, setProgress] = useState(0)
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number | null>(null)
  const startRef = useRef(0)
  const progRef = useRef(0)
  const durRef = useRef(initialDuration)

  useEffect(() => { progRef.current = progress }, [progress])

  const pause = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setPlaying(false)
  }, [])

  const play = useCallback(() => {
    if (rafRef.current != null) return
    setPlaying(true)
    startRef.current = 0
    const tick = (ts: number) => {
      if (!startRef.current) {
        const base = progRef.current >= 1 ? 0 : progRef.current // 播完后重播从头
        startRef.current = ts - base * durRef.current
      }
      const p = Math.min((ts - startRef.current) / durRef.current, 1)
      progRef.current = p
      setProgress(p)
      if (p < 1) rafRef.current = requestAnimationFrame(tick)
      else { rafRef.current = null; setPlaying(false) }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const reset = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    startRef.current = 0
    progRef.current = 0
    setProgress(0)
    setPlaying(false)
  }, [])

  const setDuration = useCallback((d: number) => {
    durRef.current = d
    startRef.current = 0 // 让下一帧以当前进度为基准重新计时 → 平滑变速
  }, [])

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }, [])

  return { progress, playing, play, pause, reset, setDuration }
}

import { Component, type ReactNode } from 'react'

// 局部错误边界:子树报错只在此降级,不会把整页(地图等)拖崩成黑屏
export default class ErrorBoundary extends Component<
  { children: ReactNode; onError?: () => void },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: unknown) { console.warn('SpotifyPopup 出错:', err); this.props.onError?.() }
  render() { return this.state.failed ? null : this.props.children }
}

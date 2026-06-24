import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 后端(FastAPI)默认跑在 :8000;dev 时把 /api 代理过去,
// 这样组件里 fetch('/api/grids/geojson') 不用改、也没跨域问题。
// 注意用 127.0.0.1 而非 localhost:Windows 下 localhost 先解析 IPv6 ::1,
// Docker 端口转发偶发在 ::1 上挂起 → 代理请求超时;IPv4 直连稳。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
    },
  },
})

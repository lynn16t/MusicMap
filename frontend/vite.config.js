import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// 后端(FastAPI)默认跑在 :8000;dev 时把 /api 代理过去,
// 这样组件里 fetch('/api/grids/geojson') 不用改、也没跨域问题。
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
            },
        },
    },
});

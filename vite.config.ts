// Интерфейс: при разработке Vite отдаёт его сам и проксирует /api на сервер (npm run dev),
// при сборке кладёт в dist/renderer — оттуда его раздаёт сервер внутри Electron.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '^/api/': { target: 'http://127.0.0.1:5174', changeOrigin: true } },
  },
});

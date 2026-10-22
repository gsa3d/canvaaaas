// Тесты ядра и сервера; у Vite свой корень (src/renderer), поэтому отдельный конфиг
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });

// Сборка main-процесса Electron: один ESM-файл, все пакеты из node_modules остаются внешними.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/electron/main.ts'],
  outfile: 'dist/electron/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'info',
});

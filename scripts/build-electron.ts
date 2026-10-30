// Сборка main-процесса Electron: ESM-файл main.mjs и рядом поток выделения объектов segment-worker.mjs,
// все пакеты из node_modules остаются внешними.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/electron/main.ts', 'src/core/segment-worker.ts'],
  outdir: 'dist/electron',
  entryNames: '[name]',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'info',
});

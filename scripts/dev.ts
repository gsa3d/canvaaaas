// Разработка в браузере: сервер (перезапускается при правках) + Vite с интерфейсом на http://127.0.0.1:5173.
// CANVAAAAS_PROVIDER=mock — без настоящих генераций; CANVAAAAS_OPEN=путь — сразу открыть картинку.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--watch', 'src/server/main.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PORT: '5174' },
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const c of children) c.kill();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', stop);

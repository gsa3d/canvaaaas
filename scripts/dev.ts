// Разработка в браузере: сервер + Vite с интерфейсом на http://127.0.0.1:5173.
// CANVAAAAS_PROVIDER=mock — без настоящих генераций; CANVAAAAS_OPEN=путь — сразу открыть картинку.
// Сервер без --watch: проект лежит в Dropbox, синхронизация «трогает» файлы через минуту-другую после правки,
// и --watch перезапускал сервер посреди платной генерации. После правок сервера перезапустите npm run dev.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server/main.ts'], {
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

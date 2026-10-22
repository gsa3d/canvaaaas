// Сервер без Electron — для разработки в браузере (npm run dev).
//   PORT — порт (по умолчанию 5174), CANVAAAAS_PROVIDER=mock — без настоящих генераций,
//   CANVAAAAS_OPEN=путь — сразу открыть картинку, CANVAAAAS_STATIC=папка — отдавать собранный интерфейс.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { defaultKeyStore } from '../core/secrets.ts';
import { startServer } from './app.ts';
import { Session } from './session.ts';

const session = new Session(process.env.CANVAAAAS_PROVIDER === 'mock' ? 'mock' : 'laozhang', defaultKeyStore());
await session.init();
const open = process.env.CANVAAAAS_OPEN;
if (open) await session.openDocument(await readFile(open), basename(open));
const server = await startServer({
  session,
  port: Number(process.env.PORT ?? 5174),
  staticDir: process.env.CANVAAAAS_STATIC,
});
console.log(`Сервер: ${server.url} (генерация: ${session.providerKind === 'mock' ? 'подставная модель' : 'laozhang.ai'})`);

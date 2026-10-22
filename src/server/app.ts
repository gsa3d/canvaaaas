// HTTP-сервер приложения. Слушает только 127.0.0.1. Чтобы чужая страница в браузере не могла
// дёрнуть API (и потратить генерации), сервер проверяет Host (защита от DNS rebinding) и требует
// заголовок x-canvaaaas у всех изменяющих запросов — с чужого сайта такой запрос без CORS не уйдёт.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { API_HEADER, type CreateJobRequest, type MaskShape } from '../shared/api.ts';
import type { Session } from './session.ts';

export interface ServerOptions {
  session: Session;
  /** 0 — любой свободный порт */
  port: number;
  /** Папка собранного интерфейса; без неё сервер отдаёт только API (интерфейс тогда даёт Vite) */
  staticDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req, 50 * 1024 * 1024);
  try {
    return JSON.parse(body.toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, 'Тело запроса — не JSON');
  }
}

function send(res: ServerResponse, status: number, body: Buffer | string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
}

const IMMUTABLE = { 'Cache-Control': 'private, max-age=31536000, immutable' };

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void> | void;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { session } = opts;
  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, pattern: string, handler: Handler) => {
    const re = new RegExp(`^${pattern.replaceAll('.', '\\.').replace(/:[a-z]+/g, '([^/.]+)')}$`);
    routes.push([method, re, handler]);
  };

  route('GET', '/api/state', (_req, res) => json(res, session.state()));

  // Сервер шлёт «что-то изменилось», интерфейс после этого перечитывает /api/state
  route('GET', '/api/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('data: hello\n\n');
    const off = session.onChange(() => res.write('data: change\n\n'));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      off();
      clearInterval(ping);
    });
  });

  route('POST', '/api/doc/upload', async (req, res, _p, url) => {
    const body = await readBody(req, 4 * 1024 * 1024 * 1024);
    if (!body.length) throw new HttpError(400, 'Пустой файл');
    await session.openDocument(body, url.searchParams.get('name') ?? 'Без имени');
    json(res, { ok: true });
  });

  route('POST', '/api/doc/new', async (req, res) => {
    const { width, height, color } = await readJson<{ width: number; height: number; color?: string }>(req);
    const hex = /^#?([0-9a-f]{6})$/i.exec(color ?? '#ffffff')?.[1] ?? 'ffffff';
    const rgb: [number, number, number] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    session.newDocument(Math.round(width), Math.round(height), rgb);
    json(res, { ok: true });
  });

  route('POST', '/api/doc/style', async (req, res) => {
    const { style } = await readJson<{ style: string }>(req);
    session.setStyle(String(style ?? ''));
    json(res, { ok: true });
  });

  route('GET', '/api/doc/tile/:k/:x/:y.jpg', async (_req, res, [k, x, y]) => {
    const doc = session.doc;
    if (!doc) throw new HttpError(404, 'Документ не открыт');
    send(res, 200, await doc.tile(Number(k), Number(x), Number(y)), 'image/jpeg', IMMUTABLE);
  });

  route('GET', '/api/doc/export.png', async (_req, res) => {
    const doc = session.doc;
    if (!doc) throw new HttpError(404, 'Документ не открыт');
    const name = `${doc.name.replace(/\.[a-z0-9]+$/i, '')}-canvaaaas.png`;
    send(res, 200, await doc.exportPng(), 'image/png', {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
  });

  // Ключ приходит из окна приложения и уходит в хранилище; обратно его не отдаёт ни один запрос
  route('POST', '/api/settings/key', async (req, res) => {
    const { key } = await readJson<{ key: string }>(req);
    await session.setKey(String(key ?? ''));
    json(res, { ok: true });
  });
  route('POST', '/api/settings/key/clear', async (_req, res) => {
    await session.clearKey();
    json(res, { ok: true });
  });

  route('POST', '/api/history/undo', (_req, res) => {
    session.undo();
    json(res, { ok: true });
  });
  route('POST', '/api/history/redo', (_req, res) => {
    session.redo();
    json(res, { ok: true });
  });
  route('POST', '/api/history/:id/toggle', (_req, res, [id]) => {
    session.togglePatch(id!);
    json(res, { ok: true });
  });

  route('POST', '/api/jobs', async (req, res) => {
    const body = await readJson<CreateJobRequest>(req);
    json(res, { id: session.createJob(body) });
  });
  route('POST', '/api/jobs/:id/select', async (req, res, [id]) => {
    const { n } = await readJson<{ n: number }>(req);
    session.selectVariant(id!, n);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/more', async (req, res, [id]) => {
    const { count } = await readJson<{ count: number }>(req);
    // Генерация идёт в фоне: прогресс интерфейс видит через события
    session.moreVariants(id!, count).catch(() => undefined);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/retry', (_req, res, [id]) => {
    session.retry(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/accept', (_req, res, [id]) => {
    session.accept(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/discard', (_req, res, [id]) => {
    session.discard(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/mask', async (req, res, [id]) => {
    const { shapes } = await readJson<{ shapes: MaskShape[] }>(req);
    await session.editMask(id!, shapes);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/mask/expand', async (_req, res, [id]) => {
    json(res, { addedPx: await session.expandMask(id!) });
  });
  route('POST', '/api/jobs/:id/mask/undo', async (_req, res, [id]) => {
    await session.undoMask(id!);
    json(res, { ok: true });
  });
  route('GET', '/api/jobs/:id/layer/:n.png', async (_req, res, [id, n]) => {
    send(res, 200, await session.layerPng(id!, Number(n)), 'image/png', IMMUTABLE);
  });
  route('GET', '/api/jobs/:id/mask.png', async (_req, res, [id]) => {
    send(res, 200, await session.maskPng(id!), 'image/png', IMMUTABLE);
  });

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!opts.staticDir) throw new HttpError(404, 'Не найдено');
    const root = resolve(opts.staticDir);
    let file = resolve(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, 'Нельзя');
    if (file === root || !extname(file)) file = join(root, 'index.html');
    try {
      const body = await readFile(file);
      send(res, 200, body, CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', { 'Cache-Control': 'no-cache' });
    } catch {
      throw new HttpError(404, 'Не найдено');
    }
  }

  let port = opts.port;
  const server = createServer(async (req, res) => {
    try {
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host ?? '')) throw new HttpError(403, 'Чужой Host');
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD' && req.headers[API_HEADER] !== '1') {
        throw new HttpError(403, 'Нет заголовка приложения');
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      for (const [m, re, handler] of routes) {
        if (m !== method) continue;
        const match = re.exec(url.pathname);
        if (match) {
          await handler(req, res, match.slice(1).map(decodeURIComponent), url);
          return;
        }
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'Нет такого запроса');
      await serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      const text = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) json(res, { error: text }, status);
      else res.end();
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port, '127.0.0.1', () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// HTTP-сервер приложения. Слушает только 127.0.0.1. Чтобы чужая страница в браузере не могла
// дёрнуть API (и потратить генерации), сервер проверяет Host (защита от DNS rebinding) и требует
// заголовок x-canvaaaas у всех изменяющих запросов — с чужого сайта такой запрос без CORS не уйдёт.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import {
  API_HEADER,
  type CreateJobRequest,
  type DetachRequest,
  type EdgeRequest,
  type GeminiService,
  type MaskShape,
  MODEL_CHOICES,
  type MoreVariantsRequest,
  type ObjectMaskRequest,
  type PatchVariantsRequest,
  type PickRequest,
  type RectDto,
  type RedoChange,
  type SnapRequest,
} from '../shared/api.ts';
import type { Session } from './session.ts';
import { L, type LangChoice } from '../shared/i18n.ts';

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
    if (size > limit) throw new HttpError(413, L('Слишком большой запрос', 'Request too large'));
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const body = await readBody(req, 50 * 1024 * 1024);
  try {
    return JSON.parse(body.toString('utf8') || '{}') as T;
  } catch {
    throw new HttpError(400, L('Тело запроса — не JSON', 'Request body is not JSON'));
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

  // Настройки интерфейса: окно читает их раз при запуске и сохраняет каждую, когда она меняется
  route('GET', '/api/prefs', (_req, res) => json(res, session.preferences()));
  route('POST', '/api/prefs', async (req, res) => {
    const { key, value } = await readJson<{ key: string; value: unknown }>(req);
    await session.setPreference(String(key), value);
    json(res, { ok: true });
  });

  // Язык интерфейса: окно читает его до первой отрисовки, после смены — перезагружается
  route('GET', '/api/lang', (_req, res) => json(res, session.language()));
  route('POST', '/api/lang', async (req, res) => {
    const { choice } = await readJson<{ choice: LangChoice }>(req);
    await session.setLanguage(choice);
    json(res, session.language());
  });

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
    if (!body.length) throw new HttpError(400, L('Пустой файл', 'Empty file'));
    json(res, { opened: await session.openDocument(body, url.searchParams.get('name') ?? L('Без имени', 'Untitled')) });
  });

  // Окна выбора файла и вопросы «Сохранить изменения?» показывает Electron; ответ приходит, когда их закроют
  route('POST', '/api/doc/open', async (_req, res) => {
    json(res, { opened: await session.openWithDialog() });
  });
  route('POST', '/api/doc/save', async (_req, res) => {
    json(res, { path: await session.save() });
  });
  route('POST', '/api/doc/save-as', async (_req, res) => {
    json(res, { path: await session.saveAs() });
  });
  route('POST', '/api/doc/export', async (_req, res) => {
    json(res, { path: await session.exportImage() });
  });
  route('POST', '/api/doc/export-psd', async (_req, res) => {
    json(res, { path: await session.exportPsd() });
  });
  route('POST', '/api/doc/cancel', async (_req, res) => {
    session.cancelFileWork();
    json(res, { ok: true });
  });

  route('POST', '/api/recent/:id/open', async (_req, res, [id]) => {
    json(res, { opened: await session.openRecent(id!) });
  });
  route('POST', '/api/recent/clear', async (_req, res) => {
    await session.clearRecent();
    json(res, { ok: true });
  });
  route('GET', '/api/recent/:id/thumb.jpg', async (_req, res, [id]) => {
    send(res, 200, await readFile(session.recentThumb(id!)), 'image/jpeg', { 'Cache-Control': 'no-cache' });
  });

  route('POST', '/api/refs', async (req, res) => {
    const body = await readBody(req, 500 * 1024 * 1024);
    if (!body.length) throw new HttpError(400, L('Пустой файл', 'Empty file'));
    json(res, { id: await session.addReference(body) });
  });
  route('GET', '/api/refs/:id/thumb.jpg', (_req, res, [id]) => {
    send(res, 200, session.referenceThumb(id!), 'image/jpeg', IMMUTABLE);
  });

  route('POST', '/api/doc/new', async (req, res) => {
    const { width, height, color, dpi } = await readJson<{ width: number; height: number; color?: string; dpi?: number }>(req);
    const hex = /^#?([0-9a-f]{6})$/i.exec(color ?? '#ffffff')?.[1] ?? 'ffffff';
    const rgb: [number, number, number] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    const density = typeof dpi === 'number' && dpi >= 1 && dpi <= 2400 ? dpi : undefined;
    json(res, { opened: await session.newDocument(Math.round(width), Math.round(height), rgb, density) });
  });

  route('POST', '/api/doc/style', async (req, res) => {
    const { style } = await readJson<{ style: string }>(req);
    session.setStyle(String(style ?? ''));
    json(res, { ok: true });
  });

  route('GET', '/api/doc/tile/:k/:x/:y.jpg', async (_req, res, [k, x, y]) => {
    const doc = session.doc;
    if (!doc) throw new HttpError(404, L('Документ не открыт', 'No document open'));
    send(res, 200, await doc.tile(Number(k), Number(x), Number(y)), 'image/jpeg', IMMUTABLE);
  });
  // Исходник без слоёв — для сравнения; он не меняется, пока документ открыт
  route('GET', '/api/doc/base/:k/:x/:y.jpg', async (_req, res, [k, x, y]) => {
    const doc = session.doc;
    if (!doc) throw new HttpError(404, L('Документ не открыт', 'No document open'));
    send(res, 200, await doc.baseTile(Number(k), Number(x), Number(y)), 'image/jpeg', IMMUTABLE);
  });

  route('GET', '/api/doc/export.png', async (_req, res) => {
    const doc = session.doc;
    if (!doc) throw new HttpError(404, L('Документ не открыт', 'No document open'));
    const name = `${doc.name.replace(/\.[a-z0-9]+$/i, '')}-canvaaaas.png`;
    send(res, 200, await doc.exportPng(), 'image/png', {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
  });
  // Проект со слоями — скачиванием, когда нет окна сохранения (интерфейс в браузере для разработки)
  route('GET', '/api/doc/export.caaa', async (_req, res) => {
    const doc = session.doc;
    if (!doc) throw new HttpError(404, L('Документ не открыт', 'No document open'));
    const name = `${doc.name.replace(/\.[a-z0-9]+$/i, '')}.caaa`;
    send(res, 200, await session.exportProject(), 'application/octet-stream', {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
  });

  // PSD — скачиванием, когда нет окна сохранения (интерфейс в браузере для разработки)
  route('GET', '/api/doc/export.psd', async (_req, res) => {
    const doc = session.doc;
    if (!doc) throw new HttpError(404, L('Документ не открыт', 'No document open'));
    const name = `${doc.name.replace(/\.[a-z0-9]+$/i, '')}.psd`;
    send(res, 200, await session.exportPsdBytes(), 'application/octet-stream', {
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'no-store',
    });
  });

  // Ключ приходит из окна приложения и уходит в хранилище; обратно его не отдаёт ни один запрос
  route('POST', '/api/settings/key', async (req, res) => {
    const { key, service } = await readJson<{ key: string; service: GeminiService }>(req);
    await session.setKey(service, String(key ?? ''));
    json(res, { ok: true });
  });
  route('POST', '/api/settings/key/clear', async (req, res) => {
    const { service } = await readJson<{ service: GeminiService }>(req);
    await session.clearKey(service);
    json(res, { ok: true });
  });
  // Через что идёт Nano Banana: Gemini API или laozhang.ai
  route('POST', '/api/settings/gemini', async (req, res) => {
    const { service } = await readJson<{ service: GeminiService }>(req);
    await session.setGeminiService(service);
    json(res, { ok: true });
  });

  route('POST', '/api/history/undo', async (_req, res) => {
    await session.undo();
    json(res, { ok: true });
  });
  route('POST', '/api/history/redo', async (_req, res) => {
    await session.redo();
    json(res, { ok: true });
  });
  route('POST', '/api/history/:id/toggle', async (_req, res, [id]) => {
    await session.togglePatch(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/history/:id/delete', async (_req, res, [id]) => {
    await session.removePatch(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/history/:id/variants', async (req, res, [id]) => {
    const body = await readJson<PatchVariantsRequest>(req);
    json(res, { id: session.patchVariants(id!, body) });
  });
  route('POST', '/api/history/:id/mask', async (req, res, [id]) => {
    const { shapes } = await readJson<{ shapes: MaskShape[] }>(req);
    json(res, await session.editPatchMask(id!, shapes));
  });
  // Картинки для правки маски в браузере. Маска меняется с каждым мазком, поэтому не кэшируются; номер её состояния — в заголовке
  const editImage = async (res: ServerResponse, image: Promise<{ data: Buffer; type: string; version: number }>) => {
    const { data, type, version } = await image;
    send(res, 200, data, type, { 'Cache-Control': 'no-store', [`${API_HEADER}-version`]: String(version) });
  };
  route('GET', '/api/history/:id/edit/:part.:ext', (_req, res, [id, part]) => editImage(res, session.maskEditImage(id!, part!)));
  route('POST', '/api/history/:id/expand', async (_req, res, [id]) => {
    json(res, { addedPx: await session.expandVersion(id!) });
  });
  route('POST', '/api/history/:id/object-mask', async (req, res, [id]) => {
    const { model } = await readJson<ObjectMaskRequest>(req);
    if (!MODEL_CHOICES.includes(model)) throw new HttpError(400, L('Непонятная модель', 'Unknown model'));
    await session.objectMask(id!, model);
    json(res, { ok: true });
  });
  // Отделённый объект картинкой — для превью сдвига; маска слоя меняется, поэтому не кэшируется
  // Миниатюры версий неизменны, пока не правили маску: её номер — в адресе
  route('GET', '/api/history/:id/thumb.png', async (_req, res, [id]) => {
    send(res, 200, await session.thumbPng(id!), 'image/png', { 'Cache-Control': 'private, max-age=31536000, immutable' });
  });
  route('GET', '/api/history/:id/mask-thumb.png', async (_req, res, [id]) => {
    send(res, 200, await session.maskThumbPng(id!), 'image/png', { 'Cache-Control': 'private, max-age=31536000, immutable' });
  });
  route('GET', '/api/history/:id/cutout.png', async (_req, res, [id]) => {
    send(res, 200, await session.cutoutPng(id!), 'image/png', { 'Cache-Control': 'no-store' });
  });

  // Выделение объектов: веса модели скачиваются по просьбе, признаки видимой части считаются заранее,
  // подсветка под курсором — картинкой маски с её местом на холсте в заголовке
  route('POST', '/api/segment/install', (_req, res) => {
    session.installSegmenter();
    json(res, { ok: true });
  });
  route('POST', '/api/segment/view', async (req, res) => {
    const { view } = await readJson<{ view: RectDto }>(req);
    // Признаки считаются секунды: ответ сразу, иначе запрос держал бы одно из шести соединений браузера и тайлы ждали бы
    session.prepareView(view).catch(() => undefined);
    json(res, { ok: true });
  });
  route('GET', '/api/segment/hover.png', async (_req, res, _p, url) => {
    const n = (k: string) => Number(url.searchParams.get(k) ?? NaN);
    const view = { x: n('vx'), y: n('vy'), width: n('vw'), height: n('vh') };
    if (![n('x'), n('y'), view.x, view.y, view.width, view.height].every(Number.isFinite)) throw new HttpError(400, L('Нет точки или вида', 'No point or view'));
    const hit = await session.hoverObject(view, n('x'), n('y'), url.searchParams.get('within') ?? undefined);
    if (!hit) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    const { x, y, width, height } = hit.rect;
    send(res, 200, hit.png, 'image/png', { 'Cache-Control': 'no-store', [`${API_HEADER}-rect`]: [x, y, width, height].join(',') });
  });
  route('POST', '/api/segment/pick', async (req, res) => {
    json(res, await session.pickObject(await readJson<PickRequest>(req)));
  });
  route('POST', '/api/segment/refine', async (req, res) => {
    const { id, snap } = await readJson<{ id: string; snap?: boolean }>(req);
    json(res, await session.refineObject(String(id), snap === true));
  });
  // Выделение одной маской: край шире или уже, мазок кисти по линиям
  route('POST', '/api/selection/edge', async (req, res) => {
    json(res, await session.selectionEdge(await readJson<EdgeRequest>(req)));
  });
  route('POST', '/api/selection/snap', async (req, res) => {
    json(res, await session.snapSelection(await readJson<SnapRequest>(req)));
  });
  // Маска объекта под щелчком или сохранённого (obj:id); у сохранённого меняется с правками — адрес несёт rev
  route('GET', '/api/masks/:id.png', async (_req, res, [id]) => {
    send(res, 200, await session.maskImage(id!), 'image/png', IMMUTABLE);
  });

  route('POST', '/api/objects', async (req, res) => {
    const { shapes, name, group } = await readJson<{ shapes: MaskShape[]; name?: string; group?: string }>(req);
    json(res, { id: await session.saveObject(shapes, name, typeof group === 'string' ? group : undefined) });
  });
  route('POST', '/api/objects/:id/rename', async (req, res, [id]) => {
    const { name } = await readJson<{ name: string }>(req);
    await session.renameObject(id!, String(name ?? ''));
    json(res, { ok: true });
  });
  route('POST', '/api/objects/:id/delete', async (_req, res, [id]) => {
    await session.deleteObject(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/objects/:id/merge-down', async (_req, res, [id]) => {
    await session.mergeIntoBase(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/objects/merge', async (req, res) => {
    const { ids } = await readJson<{ ids: string[] }>(req);
    if (!Array.isArray(ids)) throw new HttpError(400, L('Нет слоёв', 'No layers'));
    json(res, { id: await session.mergeLayers(ids.map(String)) });
  });
  route('POST', '/api/doc/flatten', async (_req, res) => {
    await session.flattenLayers();
    json(res, { ok: true });
  });
  route('POST', '/api/objects/:id/fill', async (req, res, [id]) => {
    const body = await readJson<DetachRequest>(req);
    json(res, { ids: session.fillUnder(id!, body) });
  });
  route('POST', '/api/objects/cut', async (req, res) => {
    const { shapes, name, group } = await readJson<{ shapes: MaskShape[]; name?: string; group?: string }>(req);
    json(res, { id: await session.cutObject(shapes, name, typeof group === 'string' ? group : undefined) });
  });
  route('POST', '/api/objects/:id/current', async (req, res, [id]) => {
    const { patch } = await readJson<{ patch: string | null }>(req);
    await session.setCurrent(id!, typeof patch === 'string' ? patch : null);
    json(res, { ok: true });
  });
  route('POST', '/api/objects/:id/hidden', async (req, res, [id]) => {
    const { hidden } = await readJson<{ hidden: boolean }>(req);
    await session.setHidden(id!, hidden === true);
    json(res, { ok: true });
  });
  // Слой или группа — в группу into (null — в корень) прямо над её слоем или группой over (null — под всеми в ней)
  route('POST', '/api/layers/:id/move', async (req, res, [id]) => {
    const { into, over } = await readJson<{ into: string | null; over: string | null }>(req);
    await session.moveLayer(id!, typeof into === 'string' ? into : null, typeof over === 'string' ? over : null);
    json(res, { ok: true });
  });
  route('POST', '/api/groups', async (req, res) => {
    const { ids, name } = await readJson<{ ids: string[]; name?: string }>(req);
    if (!Array.isArray(ids)) throw new HttpError(400, L('Нет слоёв', 'No layers'));
    json(res, { id: await session.groupLayers(ids.map(String), name) });
  });
  route('POST', '/api/groups/:id/ungroup', async (_req, res, [id]) => {
    await session.ungroup(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/groups/:id/rename', async (req, res, [id]) => {
    const { name } = await readJson<{ name: string }>(req);
    await session.renameGroup(id!, String(name ?? ''));
    json(res, { ok: true });
  });
  route('POST', '/api/groups/:id/hidden', async (req, res, [id]) => {
    const { hidden } = await readJson<{ hidden: boolean }>(req);
    await session.setGroupHidden(id!, hidden === true);
    json(res, { ok: true });
  });
  route('POST', '/api/groups/:id/delete', async (_req, res, [id]) => {
    await session.deleteGroup(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/objects/:id/move', async (req, res, [id]) => {
    const { dx, dy } = await readJson<{ dx: number; dy: number }>(req);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new HttpError(400, L('Нет сдвига', 'No offset'));
    json(res, await session.moveObject(id!, dx, dy));
  });

  route('POST', '/api/jobs', async (req, res) => {
    const body = await readJson<CreateJobRequest>(req);
    json(res, { id: session.createJob(body) });
  });
  route('POST', '/api/jobs/:id/more', async (req, res, [id]) => {
    const { count, ...change } = await readJson<MoreVariantsRequest>(req);
    // Генерация идёт в фоне: прогресс интерфейс видит через события. Ошибку проверки (задача ещё идёт) — сразу
    const run = session.moreVariants(id!, count, change);
    await Promise.race([run, new Promise((r) => setTimeout(r, 0))]);
    run.catch(() => undefined);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/retry', async (req, res, [id]) => {
    session.retry(id!, await readJson<RedoChange>(req));
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/stop', (_req, res, [id]) => {
    session.stop(id!);
    json(res, { ok: true });
  });
  route('POST', '/api/jobs/:id/discard', (_req, res, [id]) => {
    session.discard(id!);
    json(res, { ok: true });
  });

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (!opts.staticDir) throw new HttpError(404, L('Не найдено', 'Not found'));
    const root = resolve(opts.staticDir);
    let file = resolve(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) throw new HttpError(403, L('Нельзя', 'Forbidden'));
    if (file === root || !extname(file)) file = join(root, 'index.html');
    try {
      const body = await readFile(file);
      send(res, 200, body, CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', { 'Cache-Control': 'no-cache' });
    } catch {
      throw new HttpError(404, L('Не найдено', 'Not found'));
    }
  }

  let port = opts.port;
  const server = createServer(async (req, res) => {
    try {
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host ?? '')) throw new HttpError(403, L('Чужой Host', 'Foreign Host'));
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD' && req.headers[API_HEADER] !== '1') {
        throw new HttpError(403, L('Нет заголовка приложения', 'Missing app header'));
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
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, L('Нет такого запроса', 'No such request'));
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

// Импорт и экспорт PSD: перевод между слоями файла и документом. Сам файл читает и пишет поток (psd-worker.ts).
// Импорт: каждый слой PSD — слой со своими пикселями (исходник, как у копии ⌘J), папки — группы, нижний слой без
// прозрачности — исходник документа. Экспорт: у каждого слоя — то, что от него видно (текущая версия или исходник).
import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import sharp from 'sharp';
import { CanvasDocument, type DocGroup, type DocObject, type Patch } from './document.ts';
import type { Rect } from './frame.ts';
import { buildTree, type LayerNode } from './layer-tree.ts';
import type { PsdGroup, PsdLayer, PsdSummary } from './psd-read.ts';
import { PSD_MAX_SIDE, type PsdOutLayer, type PsdWriteOptions } from './psd-write.ts';
import { L, lang } from '../shared/i18n.ts';

export const PSD_EXTENSIONS = ['psd', 'psb'];

export type PsdRequest =
  | { type: 'open'; path: string }
  | { type: 'read'; skipHidden: boolean }
  | { type: 'write-start'; path: string; options: PsdWriteOptions }
  | { type: 'write-layer'; pixels: Uint8Array; rect: Rect }
  | { type: 'write-end'; composite: Uint8Array };

export type PsdReply =
  | { type: 'summary'; summary: PsdSummary; groups: PsdGroup[] }
  | { type: 'base'; base: Uint8Array }
  | { type: 'layer'; layer: PsdLayer }
  | { type: 'ready' }
  | { type: 'done' }
  | { type: 'too-big' }
  | { type: 'error'; message: string };

export function isPsdPath(path: string): boolean {
  return PSD_EXTENSIONS.includes(extname(path).slice(1).toLowerCase());
}

export function isPsd(data: Buffer): boolean {
  return data.length > 4 && data.toString('latin1', 0, 4) === '8BPS';
}

function workerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './psd-worker.ts' : './psd-worker.mjs', import.meta.url);
}

/** Пользователь отменил импорт или экспорт */
export class PsdCancelled extends Error {}

/** Поток на одну операцию: ответы забираются по очереди, отмена его убивает */
class PsdThread {
  private readonly worker: Worker;
  private readonly inbox: PsdReply[] = [];
  private waiter: { resolve: (r: PsdReply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort = () => this.fail(new PsdCancelled());

  constructor(signal?: AbortSignal) {
    this.signal = signal;
    this.worker = new Worker(workerUrl(), { workerData: { lang: lang() } });
    this.worker.on('message', (reply: PsdReply) => {
      if (this.waiter) {
        const { resolve } = this.waiter;
        this.waiter = null;
        resolve(reply);
      } else {
        this.inbox.push(reply);
      }
    });
    this.worker.on('error', (err: unknown) => this.fail(err instanceof Error ? err : new Error(String(err))));
    this.worker.on('exit', (code) => this.fail(new Error(L(`Поток PSD завершился (код ${code})`, `The PSD thread exited (code ${code})`))));
    if (signal?.aborted) this.onAbort();
    else signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  private fail(err: Error): void {
    this.failure ??= err;
    if (this.waiter) {
      const { reject } = this.waiter;
      this.waiter = null;
      reject(this.failure);
    }
    void this.worker.terminate();
  }

  send(msg: PsdRequest, transfer: ArrayBuffer[] = []): void {
    if (this.failure) throw this.failure;
    this.worker.postMessage(msg, transfer);
  }

  /** Следующий ответ; ошибка потока — исключением */
  async next(): Promise<Exclude<PsdReply, { type: 'error' }>> {
    if (this.failure) throw this.failure;
    const reply =
      this.inbox.shift() ??
      (await new Promise<PsdReply>((resolve, reject) => {
        this.waiter = { resolve, reject };
      }));
    if (reply.type === 'error') throw new Error(reply.message);
    return reply;
  }

  close(): void {
    this.signal?.removeEventListener('abort', this.onAbort);
    this.worker.removeAllListeners('exit');
    this.worker.removeAllListeners('error');
    void this.worker.terminate();
  }
}

function unexpected(): Error {
  return new Error(L('Поток PSD ответил не по порядку', 'The PSD thread answered out of order'));
}

export interface PsdImport {
  doc: CanvasDocument;
  density?: number;
  summary: PsdSummary;
  /** Сколько слоёв пришло */
  layers: number;
}

export interface PsdImportOptions {
  /** Сколько памяти нужно — известно до чтения пикселей: all — брать всё, visible — без скрытых, null — передумал */
  confirm?: (summary: PsdSummary) => Promise<'all' | 'visible' | null>;
  progress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Документ из PSD или PSB; null — передумал. Открытый документ не трогается, пока всё не прочитано */
export async function importPsd(path: string, name: string, opts: PsdImportOptions = {}): Promise<PsdImport | null> {
  const thread = new PsdThread(opts.signal);
  try {
    thread.send({ type: 'open', path });
    const first = await thread.next();
    if (first.type !== 'summary') throw unexpected();
    const { summary, groups: psdGroups } = first;
    const choice = opts.confirm ? await opts.confirm(summary) : 'all';
    if (!choice) return null;
    const total = choice === 'visible' ? summary.layers - summary.hidden : summary.layers;
    thread.send({ type: 'read', skipHidden: choice === 'visible' });
    const second = await thread.next();
    if (second.type !== 'base') throw unexpected();
    const base = second.base;

    const now = new Date().toISOString();
    const groupIds = new Map(psdGroups.map((g) => [g.id, randomUUID()]));
    const groups: DocGroup[] = psdGroups.map((g) => ({
      id: groupIds.get(g.id)!,
      name: g.name || L('Группа', 'Group'),
      hidden: g.hidden || undefined,
      group: g.parent !== null ? groupIds.get(g.parent) : undefined,
      createdAt: now,
    }));
    const objects: DocObject[] = [];
    const patches: Patch[] = [];
    opts.progress?.(0, total);
    for (;;) {
      const reply = await thread.next();
      if (reply.type === 'done') break;
      if (reply.type !== 'layer') throw unexpected();
      const { layer } = reply;
      const id = randomUUID();
      objects.push({
        id,
        name: layer.name,
        rect: layer.object.rect,
        mask: layer.object.mask,
        createdAt: now,
        version: 0,
        hidden: layer.hidden || undefined,
        group: layer.group !== null ? groupIds.get(layer.group) : undefined,
        imported: true,
      });
      patches.push({
        id: randomUUID(),
        rect: layer.rect,
        layer: Buffer.from(layer.rgba.buffer, layer.rgba.byteOffset, layer.rgba.byteLength),
        mask: layer.alpha,
        feather: 0,
        maskVersion: 0,
        prompt: layer.name,
        jobId: `psd:${id}`,
        variant: 0,
        active: false,
        createdAt: now,
        object: id,
        lifted: true,
      });
      opts.progress?.(objects.length, total);
    }
    const doc = CanvasDocument.restore(name, summary.width, summary.height, Buffer.from(base.buffer, base.byteOffset, base.byteLength), patches, objects, groups);
    return { doc, density: summary.density, summary, layers: objects.length };
  } finally {
    thread.close();
  }
}

/** Что записать: слои снизу вверх и откуда брать пиксели каждого */
function planLayers(doc: CanvasDocument): { layers: PsdOutLayer[]; patches: Patch[] } {
  const layers: PsdOutLayer[] = [{ kind: 'background', name: L('Фон', 'Background') }];
  const patches: Patch[] = [];
  const add = (name: string, hidden: boolean, patch: Patch | undefined) => {
    if (!patch) return;
    layers.push({ kind: 'pixels', name, hidden });
    patches.push(patch);
  };
  for (const p of doc.patches) if (!p.object && p.active) add(p.prompt, false, p);
  const shown = (o: DocObject) => (o.current ? doc.patches.find((p) => p.id === o.current) : doc.patches.find((p) => p.object === o.id && p.lifted));
  const walk = (list: LayerNode[]) => {
    for (const node of [...list].reverse()) {
      if (node.kind === 'layer') {
        // Заплатка фона — под своим слоем, части — над ним
        const under = node.members.filter((m) => m.kind === 'fill');
        const over = node.members.filter((m) => m.kind !== 'fill' && m !== node.obj);
        for (const m of [...under, node.obj, ...over]) add(m.name, !!m.hidden || (!!m.parent && !!node.obj.hidden), shown(m));
      } else {
        layers.push({ kind: 'end' });
        walk(node.children);
        layers.push({ kind: 'group', name: node.group.name, hidden: !!node.group.hidden });
      }
    }
  };
  walk(buildTree(doc.objects, doc.groups));
  return { layers, patches };
}

/** sRGB-профиль: без него Фотошоп считал бы цвета в своём рабочем пространстве */
async function srgbProfile(): Promise<Uint8Array | undefined> {
  try {
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#ffffff' } }).withIccProfile('srgb').png().toBuffer();
    return (await sharp(png).metadata()).icc;
  } catch {
    return undefined;
  }
}

function copyOf(data: Uint8Array): { copy: Uint8Array; transfer: ArrayBuffer[] } {
  const copy = new Uint8Array(data);
  return { copy, transfer: [copy.buffer as ArrayBuffer] };
}

export interface PsdExportOptions {
  density?: number;
  progress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  /** PSB вместо PSD: файл не поместился — можно ли записать по этому пути (он уже есть); false — передумал */
  allowPsb?: (path: string) => Promise<boolean>;
}

/**
 * PSD со слоями и группами. Пишет во временный файл рядом и переименовывает. Не поместился в 2 ГБ или в 30000 px —
 * пишет PSB с тем же именем и расширением .psb. Возвращает итоговый путь; null — передумал
 */
export async function exportPsd(doc: CanvasDocument, path: string, opts: PsdExportOptions = {}): Promise<string | null> {
  const { layers, patches } = planLayers(doc);
  const icc = await srgbProfile();
  const psbPath = join(dirname(path), `${basename(path, extname(path))}.psb`);
  let psb = extname(path).toLowerCase() === '.psb' || Math.max(doc.width, doc.height) > PSD_MAX_SIDE;
  for (;;) {
    const target = psb ? (extname(path).toLowerCase() === '.psb' ? path : psbPath) : path;
    if (target !== path && opts.allowPsb && !(await opts.allowPsb(target))) return null;
    const tmp = join(dirname(target), `.${basename(target)}.${randomUUID().slice(0, 8)}.tmp`);
    const thread = new PsdThread(opts.signal);
    try {
      const result = await writeAll(thread, doc, tmp, { width: doc.width, height: doc.height, psb, density: opts.density, icc, layers }, patches, opts.progress);
      if (result === 'too-big') {
        await rm(tmp, { force: true });
        psb = true;
        continue;
      }
      await rename(tmp, target);
      return target;
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    } finally {
      thread.close();
    }
  }
}

async function writeAll(thread: PsdThread, doc: CanvasDocument, path: string, options: PsdWriteOptions, patches: Patch[], progress?: (done: number, total: number) => void): Promise<'done' | 'too-big'> {
  const ready = async () => {
    const reply = await thread.next();
    if (reply.type === 'too-big') return false;
    if (reply.type !== 'ready') throw unexpected();
    return true;
  };
  thread.send({ type: 'write-start', path, options });
  if (!(await ready())) return 'too-big';
  const base = copyOf(doc.base);
  thread.send({ type: 'write-layer', pixels: base.copy, rect: { x: 0, y: 0, width: doc.width, height: doc.height } }, base.transfer);
  if (!(await ready())) return 'too-big';
  // По одному: копия слоя живёт, только пока её сжимают
  for (const [i, p] of patches.entries()) {
    progress?.(i, patches.length);
    const { copy, transfer } = copyOf(p.layer);
    thread.send({ type: 'write-layer', pixels: copy, rect: p.rect }, transfer);
    if (!(await ready())) return 'too-big';
  }
  progress?.(patches.length, patches.length);
  const composite = copyOf(doc.raw().data);
  thread.send({ type: 'write-end', composite: composite.copy }, composite.transfer);
  const end = await thread.next();
  if (end.type === 'too-big') return 'too-big';
  if (end.type !== 'done') throw unexpected();
  return 'done';
}

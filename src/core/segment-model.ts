// Веса SAM 2.1 base+ для выделения объектов: ~290 МБ, в сборку приложения не входят. Скачиваются по просьбе
// пользователя в папку данных приложения (не в Dropbox), архив проверяется по SHA-256 и распаковывается здесь же.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { appDataDir } from './ledger.ts';

export const SAM_MODEL = {
  name: 'sam2.1_hiera_base_plus',
  url: 'https://huggingface.co/vietanhdev/segment-anything-2.1-onnx-models/resolve/main/sam2.1_hiera_base_plus_20260221.zip',
  sha256: '389a2b0ba3209e4352887651d794a79e7518b186d85bd640b032ad6d5bee089a',
  size: 271_998_747,
  encoder: 'sam2.1_hiera_base_plus.encoder.onnx',
  decoder: 'sam2.1_hiera_base_plus.decoder.onnx',
};

export function modelDir(): string {
  return process.env.CANVAAAAS_SAM_DIR ?? join(appDataDir(), 'models', SAM_MODEL.name);
}

export function modelFiles(dir = modelDir()): { encoder: string; decoder: string } {
  return { encoder: join(dir, SAM_MODEL.encoder), decoder: join(dir, SAM_MODEL.decoder) };
}

export function modelInstalled(dir = modelDir()): boolean {
  const { encoder, decoder } = modelFiles(dir);
  return existsSync(encoder) && existsSync(decoder);
}

/** Скачать и распаковать веса; onProgress — доля скачанного 0..1 */
export async function installModel(opts: { dir?: string; onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}): Promise<void> {
  const dir = opts.dir ?? modelDir();
  await mkdir(dir, { recursive: true });
  const zip = join(dir, 'download.zip.part');
  try {
    const res = await fetch(SAM_MODEL.url, { signal: opts.signal, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Hugging Face ответил ${res.status}`);
    const total = Number(res.headers.get('content-length')) || SAM_MODEL.size;
    const hash = createHash('sha256');
    let got = 0;
    let shown = -1;
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        got += chunk.length;
        const pct = Math.floor((got / total) * 100);
        if (pct !== shown) {
          shown = pct;
          opts.onProgress?.(Math.min(1, got / total));
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, createWriteStream(zip), { signal: opts.signal });
    if (hash.digest('hex') !== SAM_MODEL.sha256) throw new Error('Скачанный архив модели повреждён: контрольная сумма не сходится');
    const files = modelFiles(dir);
    for (const [name, dest] of [
      [SAM_MODEL.encoder, files.encoder],
      [SAM_MODEL.decoder, files.decoder],
    ] as const) {
      await extract(zip, name, `${dest}.part`);
      await rename(`${dest}.part`, dest);
    }
  } finally {
    await rm(zip, { force: true });
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

/** Каталог zip-архива (без zip64: файлы модели меньше 4 ГБ) */
async function zipEntries(path: string): Promise<ZipEntry[]> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tail = Buffer.alloc(Math.min(size, 65_557));
    await fh.read(tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('Архив модели повреждён: нет каталога');
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dirOffset = tail.readUInt32LE(eocd + 16);
    if (dirOffset === 0xffffffff) throw new Error('Архив модели в формате zip64 — такой не распаковать');
    const cd = Buffer.alloc(dirSize);
    await fh.read(cd, 0, dirSize, dirOffset);
    const entries: ZipEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Архив модели повреждён: каталог');
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      entries.push({
        name: cd.toString('utf8', p + 46, p + 46 + nameLen),
        method: cd.readUInt16LE(p + 10),
        compressed: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/** Достать из архива файл с таким именем (в любой папке архива) */
async function extract(zip: string, name: string, dest: string): Promise<void> {
  const entry = (await zipEntries(zip)).find((e) => e.name === name || e.name.endsWith(`/${name}`));
  if (!entry) throw new Error(`В архиве модели нет ${name}`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`Архив модели сжат неизвестным способом (${entry.method})`);
  const fh = await open(zip, 'r');
  const header = Buffer.alloc(30);
  try {
    await fh.read(header, 0, 30, entry.offset);
  } finally {
    await fh.close();
  }
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Архив модели повреждён: заголовок файла');
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const source = createReadStream(zip, { start, end: start + entry.compressed - 1 });
  if (entry.method === 8) await pipeline(source, createInflateRaw(), createWriteStream(dest));
  else await pipeline(source, createWriteStream(dest));
  if ((await stat(dest)).size !== entry.size) throw new Error(`Архив модели повреждён: ${name} не того размера`);
}

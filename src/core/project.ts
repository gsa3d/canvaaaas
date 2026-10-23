// Свой формат canvaaaas, .caaa: исходник и слои правок вместе с масками. После повторного открытия
// слои можно скрывать и править их маски, как до сохранения; история отмены начинается заново.
// Внутри — подпись, длина и JSON-описание, затем PNG подряд: исходник, у каждого слоя — RGBA
// (ответ модели и растушёванная маска в альфе) и маска до растушёвки.
import { extname } from 'node:path';
import sharp from 'sharp';
import { CanvasDocument, type Patch } from './document.ts';
import type { Rect } from './frame.ts';

export const PROJECT_EXTENSION = 'caaa';
const MAGIC = Buffer.from('CAAA\r\n\x1a\n', 'latin1');
const VERSION = 1;

/** Кусок файла после описания */
interface Part {
  offset: number;
  length: number;
}

interface Manifest {
  app: 'canvaaaas';
  version: number;
  width: number;
  height: number;
  density?: number;
  style: string;
  base: Part;
  layers: {
    id: string;
    rect: Rect;
    feather: number;
    prompt: string;
    jobId: string;
    variant: number;
    active: boolean;
    createdAt: string;
    pixels: Part;
    mask: Part;
  }[];
}

export function isProjectPath(path: string): boolean {
  return extname(path).toLowerCase() === `.${PROJECT_EXTENSION}`;
}

export function isProject(data: Buffer): boolean {
  return data.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Исходник не меняется, пока документ открыт: при повторном сохранении его PNG уже готов */
const basePngs = new WeakMap<Buffer, Promise<Buffer>>();

function png(data: Uint8Array, width: number, height: number, channels: 1 | 3 | 4): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels }, limitInputPixels: false }).png().toBuffer();
}

export async function encodeProject(doc: CanvasDocument, density?: number): Promise<Buffer> {
  // Слои копируются сразу: правка маски меняет альфу слоя на месте, пока идёт кодирование
  const patches = doc.patches.map((p) => ({ ...p, layer: Buffer.from(p.layer) }));
  let base = basePngs.get(doc.base);
  if (!base) {
    base = png(doc.base, doc.width, doc.height, 3);
    basePngs.set(doc.base, base);
    base.catch(() => basePngs.delete(doc.base));
  }
  const images = await Promise.all([
    base,
    ...patches.flatMap((p) => [png(p.layer, p.rect.width, p.rect.height, 4), png(p.mask, p.rect.width, p.rect.height, 1)]),
  ]);
  let offset = 0;
  const part = (data: Buffer): Part => {
    const p = { offset, length: data.length };
    offset += data.length;
    return p;
  };
  const manifest: Manifest = {
    app: 'canvaaaas',
    version: VERSION,
    width: doc.width,
    height: doc.height,
    density,
    style: doc.style,
    base: part(images[0]!),
    layers: patches.map((p, i) => ({
      id: p.id,
      rect: p.rect,
      feather: p.feather,
      prompt: p.prompt,
      jobId: p.jobId,
      variant: p.variant,
      active: p.active,
      createdAt: p.createdAt,
      pixels: part(images[1 + i * 2]!),
      mask: part(images[2 + i * 2]!),
    })),
  };
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json, ...images]);
}

/** Открыть проект: документ со слоями, стилем и разрешением для печати */
export async function openProject(data: Buffer, name: string): Promise<{ doc: CanvasDocument; density?: number }> {
  const broken = (why: string) => new Error(`Не открыть «${name}»: ${why}`);
  if (!isProject(data)) throw broken('это не проект canvaaaas или файл повреждён');
  const start = MAGIC.length + 4;
  const body = start + data.readUInt32BE(MAGIC.length);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(data.toString('utf8', start, body)) as Manifest;
  } catch {
    throw broken('файл повреждён');
  }
  if (manifest.version > VERSION) throw broken('проект сохранён более новой версией canvaaaas — обновите приложение');
  const { width, height } = manifest;
  const slice = (p: Part) => {
    if (body + p.offset + p.length > data.length) throw broken('файл обрезан');
    return data.subarray(body + p.offset, body + p.offset + p.length);
  };
  const decode = async (p: Part, w: number, h: number, channels: 1 | 3 | 4) => {
    let img = sharp(slice(p), { limitInputPixels: false });
    img = channels === 1 ? img.extractChannel(0) : channels === 3 ? img.removeAlpha() : img.ensureAlpha();
    const { data: raw, info } = await img.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    if (info.width !== w || info.height !== h || info.channels !== channels) throw broken('размеры слоёв не сходятся');
    return raw;
  };

  const baseBytes = slice(manifest.base);
  const [base, ...layers] = await Promise.all([
    decode(manifest.base, width, height, 3),
    ...manifest.layers.flatMap((l) => [decode(l.pixels, l.rect.width, l.rect.height, 4), decode(l.mask, l.rect.width, l.rect.height, 1)]),
  ]);
  const patches = manifest.layers.map((l, i): Patch => {
    const { x, y, width: w, height: h } = l.rect;
    if (x < 0 || y < 0 || x + w > width || y + h > height) throw broken('слой за краем холста');
    return {
      id: l.id,
      rect: l.rect,
      layer: layers[i * 2]!,
      mask: layers[i * 2 + 1]!,
      feather: l.feather,
      maskVersion: 0,
      prompt: l.prompt,
      jobId: l.jobId,
      variant: l.variant,
      active: l.active,
      createdAt: l.createdAt,
    };
  });
  const doc = CanvasDocument.restore(name, width, height, base!, patches);
  doc.style = manifest.style ?? '';
  basePngs.set(doc.base, Promise.resolve(Buffer.from(baseBytes)));
  return { doc, density: manifest.density };
}

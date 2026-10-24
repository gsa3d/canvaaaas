// Свой формат canvaaaas, .caaa: исходник и слои правок вместе с масками. После повторного открытия
// слои можно скрывать и править их маски, как до сохранения; история отмены начинается заново.
// Внутри — подпись, длина и JSON-описание, затем PNG подряд: исходник, у каждого слоя — RGBA
// (ответ модели и растушёванная маска в альфе) и маска до растушёвки; в конце — референсы слоёв,
// чтобы слой можно было перерисовать ещё раз и после повторного открытия. Набросок и текст директора — в описании.
import { extname } from 'node:path';
import sharp from 'sharp';
import type { InputImage } from '../providers/types.ts';
import type { ModelChoice, SizeChoice, SketchStroke } from '../shared/api.ts';
import { CanvasDocument, type Patch } from './document.ts';
import type { Rect } from './frame.ts';
import { checkSketch } from './sketch.ts';

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
    model?: ModelChoice;
    size?: SizeChoice;
    /** Номера в refs */
    refs?: number[];
    /** Модель не видела, что было под маской */
    hide?: boolean;
    directed?: string;
    sketch?: SketchStroke[];
  }[];
  /** Референсы: картинка, которая ушла с несколькими правками, хранится один раз */
  refs?: { mimeType: string; data: Part }[];
}

const MODELS: readonly string[] = ['flash', 'pro', 'chatgpt'] satisfies ModelChoice[];
const SIZES: readonly string[] = ['auto', '1K', '2K', '4K'] satisfies SizeChoice[];

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
  const refs: InputImage[] = [];
  const refIndex = (ref: InputImage): number => {
    const i = refs.findIndex((r) => r.data === ref.data);
    return i >= 0 ? i : refs.push(ref) - 1;
  };
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
      model: p.model,
      size: p.size,
      refs: p.refs?.map(refIndex),
      hide: p.hide || undefined,
      directed: p.directed,
      sketch: p.sketch?.length ? p.sketch : undefined,
    })),
  };
  manifest.refs = refs.map((r) => ({ mimeType: r.mimeType, data: part(r.data) }));
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json, ...images, ...refs.map((r) => r.data)]);
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
  // Копия, а не кусок файла: иначе в памяти остался бы весь файл
  const refs = (manifest.refs ?? []).map((r): InputImage => ({ mimeType: r.mimeType, data: Buffer.from(slice(r.data)) }));
  const patches = manifest.layers.map((l, i): Patch => {
    const { x, y, width: w, height: h } = l.rect;
    if (x < 0 || y < 0 || x + w > width || y + h > height) throw broken('слой за краем холста');
    const layerRefs = l.refs?.map((n) => {
      const ref = refs[n];
      if (!ref) throw broken('нет референса слоя');
      return ref;
    });
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
      model: l.model && MODELS.includes(l.model) ? l.model : undefined,
      size: l.size && SIZES.includes(l.size) ? l.size : undefined,
      refs: layerRefs,
      hide: l.hide === true || undefined,
      directed: typeof l.directed === 'string' && l.directed.trim() ? l.directed : undefined,
      sketch: readSketch(l.sketch),
    };
  });
  const doc = CanvasDocument.restore(name, width, height, base!, patches);
  doc.style = manifest.style ?? '';
  basePngs.set(doc.base, Promise.resolve(Buffer.from(baseBytes)));
  return { doc, density: manifest.density };
}

/** Набросок слоя; испорченный не мешает открыть проект — слой просто остаётся без него */
function readSketch(value: unknown): SketchStroke[] | undefined {
  try {
    const sketch = checkSketch(value);
    return sketch.length ? sketch : undefined;
  } catch {
    return undefined;
  }
}

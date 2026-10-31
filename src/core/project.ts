// Свой формат canvaaaas, .caaa: исходник, слои и все их версии с масками. После повторного открытия
// версии можно переключать, слои скрывать и править маски, как до сохранения; история отмены начинается заново.
// Внутри — подпись, длина и JSON-описание, затем PNG подряд: исходник, у каждой версии — RGBA
// (ответ модели и растушёванная маска в альфе) и маска до растушёвки, маски слоёв, маски правок части слоя; в конце — референсы версий,
// чтобы перерисовать ещё раз и после повторного открытия. Набросок и текст директора — в описании.
// В описании версии лежат в layers, а слои — в objects: так назывались правки и объекты в проектах 1.
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import sharp from 'sharp';
import type { InputImage } from '../providers/types.ts';
import type { ModelChoice, SizeChoice, SketchStroke } from '../shared/api.ts';
import { CanvasDocument, type DocGroup, type DocObject, type Patch } from './document.ts';
import type { Rect } from './frame.ts';
import { layerName, trim } from './objects.ts';
import { checkSketch } from './sketch.ts';
import { L } from '../shared/i18n.ts';

export const PROJECT_EXTENSION = 'caaa';
const MAGIC = Buffer.from('CAAA\r\n\x1a\n', 'latin1');
/** 2 — слои с версиями: у слоя текущая версия и видимость, заплатки фона; проекты 1 при открытии переводятся */
const VERSION = 2;

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
    critique?: { done: boolean; text: string };
    sketch?: SketchStroke[];
    /** Слой, чья это версия (в проектах 1 — объект, который правили) */
    object?: string;
    /** Снятый исходник отделённого слоя object */
    lifted?: boolean;
    /** Версия слоя, которую видела модель; у правки части слоя — та, поверх которой она легла, и маска самой правки */
    base?: string;
    part?: Part;
  }[];
  /** Слои: имя, маска размером с rect, слой, частью которого этот является, видимость, текущая версия, заплатка фона */
  objects?: {
    id: string;
    name: string;
    rect: Rect;
    parent?: string;
    createdAt: string;
    lost?: boolean;
    hidden?: boolean;
    current?: string;
    kind?: 'fill';
    under?: string;
    edit?: boolean;
    freed?: boolean;
    /** Откуда слой вырезали: рамка и маска дыры */
    hole?: { rect: Rect; mask: Part };
    mask: Part;
    /** Группа, в которой лежит слой */
    group?: string;
  }[];
  /** Группы слоёв: имя, видимость и группа, в которой лежит эта */
  groups?: { id: string; name: string; hidden?: boolean; group?: string; createdAt: string }[];
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

/** PNG исходника — пока в него ничего не влили (то же состояние), при повторном сохранении он уже готов */
const basePngs = new WeakMap<Buffer, { state: number; png: Promise<Buffer> }>();

function png(data: Uint8Array, width: number, height: number, channels: 1 | 3 | 4): Promise<Buffer> {
  return sharp(data, { raw: { width, height, channels }, limitInputPixels: false }).png().toBuffer();
}

export async function encodeProject(doc: CanvasDocument, density?: number): Promise<Buffer> {
  // Слои копируются сразу: правка маски меняет альфу слоя на месте, пока идёт кодирование
  const patches = doc.patches.map((p) => ({ ...p, layer: Buffer.from(p.layer) }));
  const objects = doc.objects;
  const cached = basePngs.get(doc.base);
  let base = cached?.state === doc.baseState ? cached.png : undefined;
  if (!base) {
    // Исходник копируется сразу: пока кодируется, в него могут влить слой
    base = png(doc.baseState ? Buffer.from(doc.base) : doc.base, doc.width, doc.height, 3);
    const entry = { state: doc.baseState, png: base };
    basePngs.set(doc.base, entry);
    base.catch(() => {
      if (basePngs.get(doc.base) === entry) basePngs.delete(doc.base);
    });
  }
  const images = await Promise.all([
    base,
    ...patches.flatMap((p) => [png(p.layer, p.rect.width, p.rect.height, 4), png(p.mask, p.rect.width, p.rect.height, 1)]),
    ...objects.map((o) => png(o.mask, o.rect.width, o.rect.height, 1)),
    ...patches.flatMap((p) => (p.part ? [png(p.part, p.rect.width, p.rect.height, 1)] : [])),
    ...objects.flatMap((o) => (o.hole ? [png(o.hole.mask, o.hole.rect.width, o.hole.rect.height, 1)] : [])),
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
      critique: p.critique,
      sketch: p.sketch?.length ? p.sketch : undefined,
      object: p.object,
      lifted: p.lifted || undefined,
      base: p.base,
    })),
  };
  const first = 1 + patches.length * 2;
  manifest.objects = objects.map((o, i) => ({
    id: o.id,
    name: o.name,
    rect: o.rect,
    parent: o.parent,
    createdAt: o.createdAt,
    lost: o.lost || undefined,
    hidden: o.hidden || undefined,
    current: o.current,
    kind: o.kind,
    under: o.under,
    edit: o.edit || undefined,
    freed: o.freed || undefined,
    mask: part(images[first + i]!),
    group: o.group,
  }));
  manifest.groups = doc.groups.map((g) => ({ id: g.id, name: g.name, hidden: g.hidden || undefined, group: g.group, createdAt: g.createdAt }));
  let parts = first + objects.length;
  patches.forEach((p, i) => {
    if (p.part) manifest.layers[i]!.part = part(images[parts++]!);
  });
  objects.forEach((o, i) => {
    if (o.hole) manifest.objects![i]!.hole = { rect: o.hole.rect, mask: part(images[parts++]!) };
  });
  manifest.refs = refs.map((r) => ({ mimeType: r.mimeType, data: part(r.data) }));
  const json = Buffer.from(JSON.stringify(manifest), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json, ...images, ...refs.map((r) => r.data)]);
}

/** Открыть проект: документ со слоями, стилем и разрешением для печати */
export async function openProject(data: Buffer, name: string): Promise<{ doc: CanvasDocument; density?: number }> {
  const broken = (why: string) => new Error(L(`Не открыть «${name}»: ${why}`, `Cannot open “${name}”: ${why}`));
  if (!isProject(data)) throw broken(L('это не проект canvaaaas или файл повреждён', 'this is not a canvaaaas project or the file is damaged'));
  const start = MAGIC.length + 4;
  const body = start + data.readUInt32BE(MAGIC.length);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(data.toString('utf8', start, body)) as Manifest;
  } catch {
    throw broken(L('файл повреждён', 'the file is damaged'));
  }
  if (manifest.version > VERSION) throw broken(L('проект сохранён более новой версией canvaaaas — обновите приложение', 'the project was saved by a newer version of canvaaaas — update the app'));
  const { width, height } = manifest;
  const slice = (p: Part) => {
    if (body + p.offset + p.length > data.length) throw broken(L('файл обрезан', 'the file is truncated'));
    return data.subarray(body + p.offset, body + p.offset + p.length);
  };
  const decode = async (p: Part, w: number, h: number, channels: 1 | 3 | 4) => {
    let img = sharp(slice(p), { limitInputPixels: false });
    img = channels === 1 ? img.extractChannel(0) : channels === 3 ? img.removeAlpha() : img.ensureAlpha();
    const { data: raw, info } = await img.raw({ depth: 'uchar' }).toBuffer({ resolveWithObject: true });
    if (info.width !== w || info.height !== h || info.channels !== channels) throw broken(L('размеры слоёв не сходятся', 'layer sizes do not match'));
    return raw;
  };

  const baseBytes = slice(manifest.base);
  const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= width && r.y + r.height <= height;
  const objectList = manifest.objects ?? [];
  for (const o of objectList) if (!inside(o.rect)) throw broken(L('объект за краем холста', 'an object is outside the canvas'));
  const [base, ...layers] = await Promise.all([
    decode(manifest.base, width, height, 3),
    ...manifest.layers.flatMap((l) => [decode(l.pixels, l.rect.width, l.rect.height, 4), decode(l.mask, l.rect.width, l.rect.height, 1)]),
  ]);
  const objectMasks = await Promise.all(objectList.map((o) => decode(o.mask, o.rect.width, o.rect.height, 1)));
  const holes = await Promise.all(objectList.map((o) => (o.hole && inside(o.hole.rect) ? decode(o.hole.mask, o.hole.rect.width, o.hole.rect.height, 1) : undefined)));
  const partMasks = await Promise.all(manifest.layers.map((l) => (l.part && typeof l.base === 'string' ? decode(l.part, l.rect.width, l.rect.height, 1) : undefined)));
  const ids = new Set(objectList.map((o) => o.id));
  const layerIds = new Set(manifest.layers.map((l) => l.id));
  const objects = objectList.map(
    (o, i): DocObject => ({
      id: o.id,
      name: String(o.name ?? ''),
      rect: o.rect,
      mask: objectMasks[i]!,
      parent: o.parent && ids.has(o.parent) && o.parent !== o.id ? o.parent : undefined,
      createdAt: o.createdAt,
      version: 0,
      lost: o.lost === true || undefined,
      hidden: o.hidden === true || undefined,
      current: typeof o.current === 'string' && layerIds.has(o.current) ? o.current : undefined,
      kind: o.kind === 'fill' ? 'fill' : undefined,
      under: o.kind === 'fill' && typeof o.under === 'string' ? o.under : undefined,
      edit: o.edit === true || undefined,
      freed: o.freed === true || undefined,
      hole: holes[i] ? { rect: o.hole!.rect, mask: new Uint8Array(holes[i]!) } : undefined,
      group: typeof o.group === 'string' ? o.group : undefined,
    }),
  );
  // Группы, которых нет, у слоёв не остаются; петли в группах обрывает дерево слоёв (layer-tree.ts)
  const groupList = (manifest.groups ?? []).filter((g) => typeof g?.id === 'string');
  const groupIds = new Set(groupList.map((g) => g.id));
  const groups = groupList.map(
    (g): DocGroup => ({
      id: g.id,
      name: String(g.name ?? ''),
      hidden: g.hidden === true || undefined,
      group: typeof g.group === 'string' && groupIds.has(g.group) && g.group !== g.id ? g.group : undefined,
      createdAt: String(g.createdAt ?? ''),
    }),
  );
  for (const o of objects) if (o.group && !groupIds.has(o.group)) o.group = undefined;
  // Копия, а не кусок файла: иначе в памяти остался бы весь файл
  const refs = (manifest.refs ?? []).map((r): InputImage => ({ mimeType: r.mimeType, data: Buffer.from(slice(r.data)) }));
  const patches = manifest.layers.map((l, i): Patch => {
    const { x, y, width: w, height: h } = l.rect;
    if (x < 0 || y < 0 || x + w > width || y + h > height) throw broken(L('слой за краем холста', 'a layer is outside the canvas'));
    const layerRefs = l.refs?.map((n) => {
      const ref = refs[n];
      if (!ref) throw broken(L('нет референса слоя', 'a layer reference is missing'));
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
      critique: l.critique && typeof l.critique.text === 'string' ? { done: l.critique.done === true, text: l.critique.text } : undefined,
      sketch: readSketch(l.sketch),
      object: typeof l.object === 'string' && ids.has(l.object) ? l.object : undefined,
      lifted: (l.lifted === true && typeof l.object === 'string' && ids.has(l.object)) || undefined,
      base: typeof l.base === 'string' && layerIds.has(l.base) ? l.base : undefined,
      part: partMasks[i] && layerIds.has(l.base!) ? new Uint8Array(partMasks[i]!) : undefined,
    };
  });
  if (manifest.version < 2) migrate(patches, objects);
  const doc = CanvasDocument.restore(name, width, height, base!, patches, objects, groups);
  doc.style = manifest.style ?? '';
  basePngs.set(doc.base, { state: doc.baseState, png: Promise.resolve(Buffer.from(baseBytes)) });
  return { doc, density: manifest.density };
}

/**
 * Проект 1 — в слои с версиями: каждая правка становится слоем (имя — задача) с ней одной текущей версией, скрытая — скрытым
 * слоем; снятый исходник отделённого объекта остаётся его, а фон, дорисованный под ним той же задачей, — заплаткой фона.
 * Новые слои — поверх прежних объектов по порядку правок, поэтому холст тот же
 */
function migrate(patches: Patch[], objects: DocObject[]): void {
  const lifted = new Map(patches.filter((p) => p.lifted && p.object).map((p) => [p.jobId, p.object!]));
  for (const p of patches) {
    if (p.lifted) continue;
    const bitmap = trim({ rect: p.rect, mask: p.mask }) ?? { rect: { ...p.rect, width: 1, height: 1 }, mask: new Uint8Array([255]) };
    const under = lifted.get(p.jobId);
    const owner = under ? objects.find((o) => o.id === under) : undefined;
    const layer: DocObject = {
      id: randomUUID(),
      name: owner ? L(`Фон под «${owner.name}»`, `Background under “${owner.name}”`) : layerName(p.prompt),
      ...bitmap,
      createdAt: p.createdAt,
      version: 0,
      hidden: !p.active || undefined,
      current: p.id,
      kind: owner ? 'fill' : undefined,
      under: owner?.id,
      edit: !owner || undefined,
    };
    objects.push(layer);
    p.object = layer.id;
  }
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

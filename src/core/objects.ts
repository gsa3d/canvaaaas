// Объекты на холсте — дерево масок: крупный объект и его части. Здесь — что считается над масками:
// площадь и пересечение, куда объект встаёт в дереве, задела ли правка его край.
import type { DocObject } from './document.ts';
import { intersect, type Rect } from './frame.ts';
import { insideDistance, MASK_THRESHOLD } from './mask.ts';
import type { Bitmap } from './segment.ts';

/** Часть должна лежать внутри объекта хотя бы на такую долю своей площади */
const CONTAINED = 0.9;
/** Насколько пиксель должен измениться, чтобы правка его «задела» (как в expand.ts) */
const DIFF_THRESHOLD = 28;

export function area(b: Bitmap): number {
  let n = 0;
  for (const v of b.mask) if (v >= MASK_THRESHOLD) n++;
  return n;
}

/** Сколько пикселей у двух масок общие */
export function overlap(a: Bitmap, b: Bitmap): number {
  const r = intersect(a.rect, b.rect);
  let n = 0;
  for (let y = r.y; y < r.y + r.height; y++) {
    const ia = (y - a.rect.y) * a.rect.width - a.rect.x;
    const ib = (y - b.rect.y) * b.rect.width - b.rect.x;
    for (let x = r.x; x < r.x + r.width; x++) {
      if (a.mask[ia + x]! >= MASK_THRESHOLD && b.mask[ib + x]! >= MASK_THRESHOLD) n++;
    }
  }
  return n;
}

/** Маска, обрезанная по выделенным пикселям; null — пустая */
export function trim(b: Bitmap): Bitmap | null {
  const { rect, mask } = b;
  let x0 = rect.width;
  let y0 = rect.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < rect.height; y++) {
    for (let x = 0; x < rect.width; x++) {
      if (mask[y * rect.width + x]! < MASK_THRESHOLD) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  if (x1 < 0) return null;
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + x] = mask[(y0 + y) * rect.width + x0 + x]! >= MASK_THRESHOLD ? 255 : 0;
  }
  return { rect: { x: rect.x + x0, y: rect.y + y0, width: w, height: h }, mask: out };
}

/** Цепочка родителей объекта, ближний первым */
export function ancestors(objects: DocObject[], id: string): DocObject[] {
  const out: DocObject[] = [];
  let parent = objects.find((o) => o.id === id)?.parent;
  while (parent && !out.some((o) => o.id === parent)) {
    const p = objects.find((o) => o.id === parent);
    if (!p) break;
    out.push(p);
    parent = p.parent;
  }
  return out;
}

/**
 * Список объектов с новым: его родитель — самый маленький объект, внутри которого он лежит, а объекты того же уровня,
 * которые лежат внутри нового, становятся его частями. Так «объединить» — это просто сохранить объект из нескольких.
 * Слой из генерации (edit) целым не бывает: он не родитель и частей себе не забирает. Заплатки фона — вне дерева.
 */
export function placeObject(objects: DocObject[], obj: DocObject): DocObject[] {
  const size = area(obj);
  // Заплатки фона — не в дереве: они лежат под всеми слоями
  const areas = new Map(objects.filter((o) => o.kind !== 'fill').map((o) => [o.id, area(o)]));
  let parent: DocObject | undefined;
  for (const o of objects) {
    if (o.kind === 'fill' || o.edit) continue;
    const a = areas.get(o.id)!;
    if (a <= size || overlap(o, obj) < CONTAINED * size) continue;
    if (!parent || a < areas.get(parent.id)!) parent = o;
  }
  const placed = { ...obj, parent: parent?.id };
  const next = objects.map((o) => {
    if (o.kind === 'fill' || obj.edit) return o;
    const a = areas.get(o.id)!;
    if (o.parent !== placed.parent || a >= size || overlap(o, obj) < CONTAINED * a) return o;
    return { ...o, parent: placed.id };
  });
  return [...next, placed];
}

/** Части объекта, части частей и так далее */
export function descendants(objects: DocObject[], id: string): DocObject[] {
  const out: DocObject[] = [];
  const seen = new Set([id]);
  for (let i = -1; i < out.length; i++) {
    const parent = i < 0 ? id : out[i]!.id;
    for (const o of objects) {
      if (o.parent !== parent || seen.has(o.id)) continue;
      seen.add(o.id);
      out.push(o);
    }
  }
  return out;
}

/** Маска, раздутая на r пикселей во все стороны (не за пределы bounds) */
export function dilate(b: Bitmap, r: number, bounds: Rect): Bitmap {
  const rect = intersect(bounds, { x: b.rect.x - r, y: b.rect.y - r, width: b.rect.width + 2 * r, height: b.rect.height + 2 * r });
  // Расстояние до маски считается как у растушёвки, только «выделено» здесь всё, что не маска
  const outside = new Uint8Array(rect.width * rect.height).fill(255);
  for (let y = 0; y < b.rect.height; y++) {
    const ty = b.rect.y + y - rect.y;
    if (ty < 0 || ty >= rect.height) continue;
    for (let x = 0; x < b.rect.width; x++) {
      const tx = b.rect.x + x - rect.x;
      if (tx >= 0 && tx < rect.width && b.mask[y * b.rect.width + x]! >= MASK_THRESHOLD) outside[ty * rect.width + tx] = 0;
    }
  }
  const d = insideDistance(outside, rect.width, rect.height);
  const mask = new Uint8Array(rect.width * rect.height);
  for (let i = 0; i < mask.length; i++) if (d[i]! <= r) mask[i] = 255;
  return { rect, mask };
}

/** Имя слоя из задачи: первые слова, не длиннее 40 знаков */
export function layerName(prompt: string): string {
  const text = prompt.trim().replace(/\s+/g, ' ');
  return text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text || 'Слой';
}

/** Без объекта: его части переходят к его родителю */
export function removeObject(objects: DocObject[], id: string): DocObject[] {
  const gone = objects.find((o) => o.id === id);
  if (!gone) throw new Error('Нет такого объекта');
  return objects.filter((o) => o.id !== id).map((o) => (o.parent === id ? { ...o, parent: gone.parent } : o));
}

/** Где правка заметно поменяла пиксели: 1 — поменяла; before и after — RGB размером с участок */
export function changedPixels(before: Uint8Array, after: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const d = Math.max(Math.abs(before[i * 3]! - after[i * 3]!), Math.abs(before[i * 3 + 1]! - after[i * 3 + 1]!), Math.abs(before[i * 3 + 2]! - after[i * 3 + 2]!));
    if (d > DIFF_THRESHOLD) out[i] = 1;
  }
  return out;
}

/**
 * Задела ли правка край объекта: изменённые пиксели ближе band к границе маски — изнутри или снаружи.
 * Правка глубоко внутри большого объекта (окно в доме) его контур не меняет — такой объект пересчитывать незачем.
 * changed — изменённые пиксели участка region. Возвращает рамку задевших пикселей или null.
 */
export function touchedEdge(obj: Bitmap, changed: Uint8Array, region: Rect, band = Math.max(4, Math.round(0.02 * Math.max(obj.rect.width, obj.rect.height)))): Rect | null {
  // Участок вокруг объекта с запасом band: снаружи считается расстояние до маски, внутри — до её края
  const box = intersect(region, { x: obj.rect.x - band, y: obj.rect.y - band, width: obj.rect.width + 2 * band, height: obj.rect.height + 2 * band });
  if (!box.width || !box.height) return null;
  const inside = new Uint8Array(box.width * box.height);
  const outside = new Uint8Array(box.width * box.height);
  for (let y = 0; y < box.height; y++) {
    for (let x = 0; x < box.width; x++) {
      const ox = box.x + x - obj.rect.x;
      const oy = box.y + y - obj.rect.y;
      const on = ox >= 0 && oy >= 0 && ox < obj.rect.width && oy < obj.rect.height && obj.mask[oy * obj.rect.width + ox]! >= MASK_THRESHOLD;
      inside[y * box.width + x] = on ? 255 : 0;
      outside[y * box.width + x] = on ? 0 : 255;
    }
  }
  const din = insideDistance(inside, box.width, box.height);
  const dout = insideDistance(outside, box.width, box.height);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let hits = 0;
  for (let y = 0; y < box.height; y++) {
    const row = (box.y + y - region.y) * region.width + box.x - region.x;
    for (let x = 0; x < box.width; x++) {
      if (!changed[row + x]) continue;
      const i = y * box.width + x;
      // У края участка вокруг объекта расстояние наружу ограничено им самим: дальше band — не край
      if ((inside[i] ? din[i]! : dout[i]!) > band) continue;
      hits++;
      x0 = Math.min(x0, box.x + x);
      y0 = Math.min(y0, box.y + y);
      x1 = Math.max(x1, box.x + x);
      y1 = Math.max(y1, box.y + y);
    }
  }
  // Пара случайных пикселей сжатия — не правка
  if (hits < 16) return null;
  return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

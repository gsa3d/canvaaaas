// Слои на холсте — маски: здесь то, что считается над масками: площадь, пересечение, обрезка и объединение,
// части слоя (дерево из проектов, где слои вкладывались друг в друга).
import type { DocObject } from './document.ts';
import { intersect, type Rect } from './frame.ts';
import { insideDistance, MASK_THRESHOLD } from './mask.ts';
import type { Bitmap } from './segment.ts';
import { L } from '../shared/i18n.ts';


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

/** Часть маски внутри маски within; null — её там нет */
export function clipBitmap(b: Bitmap, within: Bitmap): Bitmap | null {
  const rect = intersect(b.rect, within.rect);
  if (!rect.width || !rect.height) return null;
  const mask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) {
    const ib = (rect.y + y - b.rect.y) * b.rect.width + rect.x - b.rect.x;
    const iw = (rect.y + y - within.rect.y) * within.rect.width + rect.x - within.rect.x;
    for (let x = 0; x < rect.width; x++) mask[y * rect.width + x] = Math.min(b.mask[ib + x]!, within.mask[iw + x]!);
  }
  return trim({ rect, mask });
}

/** Маска в масштабе k от холста (подсветка под курсором), обрезанная по маске within в масштабе холста */
export function clipScaled(b: Bitmap, within: Bitmap, k: number): Bitmap | null {
  const { rect } = b;
  const mask = new Uint8Array(b.mask);
  const w = within.rect;
  for (let y = 0; y < rect.height; y++) {
    const cy = Math.floor((rect.y + y + 0.5) / k) - w.y;
    for (let x = 0; x < rect.width; x++) {
      const i = y * rect.width + x;
      if (!mask[i]) continue;
      const cx = Math.floor((rect.x + x + 0.5) / k) - w.x;
      if (cx < 0 || cy < 0 || cx >= w.width || cy >= w.height || within.mask[cy * w.width + cx]! < MASK_THRESHOLD) mask[i] = 0;
    }
  }
  return trim({ rect, mask });
}

/** Маска без того, что накрывают маски cut (фон — всё, кроме слоёв); k — масштаб маски от холста, как у подсветки */
export function clipOut(b: Bitmap, cut: Bitmap[], k = 1): Bitmap | null {
  const { rect } = b;
  const mask = new Uint8Array(b.mask);
  for (const c of cut) {
    // Участок c в масштабе маски, пересечённый с её рамкой
    const x0 = Math.max(rect.x, Math.floor(c.rect.x * k));
    const y0 = Math.max(rect.y, Math.floor(c.rect.y * k));
    const x1 = Math.min(rect.x + rect.width, Math.ceil((c.rect.x + c.rect.width) * k));
    const y1 = Math.min(rect.y + rect.height, Math.ceil((c.rect.y + c.rect.height) * k));
    for (let y = y0; y < y1; y++) {
      const cy = Math.floor((y + 0.5) / k) - c.rect.y;
      if (cy < 0 || cy >= c.rect.height) continue;
      for (let x = x0; x < x1; x++) {
        const cx = Math.floor((x + 0.5) / k) - c.rect.x;
        if (cx >= 0 && cx < c.rect.width && c.mask[cy * c.rect.width + cx]! >= MASK_THRESHOLD) mask[(y - rect.y) * rect.width + x - rect.x] = 0;
      }
    }
  }
  return trim({ rect, mask });
}

/** Обе маски одной */
export function unionBitmap(a: Bitmap, b: Bitmap): Bitmap {
  const x = Math.min(a.rect.x, b.rect.x);
  const y = Math.min(a.rect.y, b.rect.y);
  const rect = { x, y, width: Math.max(a.rect.x + a.rect.width, b.rect.x + b.rect.width) - x, height: Math.max(a.rect.y + a.rect.height, b.rect.y + b.rect.height) - y };
  const mask = new Uint8Array(rect.width * rect.height);
  for (const src of [a, b]) {
    for (let row = 0; row < src.rect.height; row++) {
      const to = (src.rect.y + row - y) * rect.width + src.rect.x - x;
      for (let col = 0; col < src.rect.width; col++) mask[to + col] = Math.max(mask[to + col]!, src.mask[row * src.rect.width + col]!);
    }
  }
  return { rect, mask };
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
  return text.length > 40 ? `${text.slice(0, 39).trimEnd()}…` : text || L('Слой', 'Layer');
}

/** Без объекта: его части переходят к его родителю */
export function removeObject(objects: DocObject[], id: string): DocObject[] {
  const gone = objects.find((o) => o.id === id);
  if (!gone) throw new Error(L('Нет такого объекта', 'No such object'));
  return objects.filter((o) => o.id !== id).map((o) => (o.parent === id ? { ...o, parent: gone.parent } : o));
}

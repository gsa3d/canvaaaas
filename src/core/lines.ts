// Штриховой рисунок: тёмные линии и светлые области между ними. По ним выделение ложится точно, а не клетками сетки модели:
// край объекта, найденного ИИ, и мазок кисти привязываются к линиям (snapToLines).
// Щели в линиях до 2·gap пикселей считаются закрытыми: иначе область протекает в соседнюю (поток — в чашу фонтана).
import { intersect, type Rect } from './frame.ts';
import { insideDistance } from './mask.ts';
import { dilate, trim } from './objects.ts';
import type { Bitmap } from './segment.ts';

/** Темнее этого — линия */
const LINE = 140;
/** Ширина линии рисунка, пиксели: на столько от выделенного берётся его контур */
const LINE_WIDTH = 5;
/** Область, покрытая маской на эту долю, берётся целиком; не больше STRAY — выбрасывается; между — как в маске */
const WHOLE = 0.6;
const STRAY = 0.15;

/** Участок холста, разбитый на области между линиями: у светлого пикселя — номер области, у линии и щели — −1 */
export interface LineMap {
  rect: Rect;
  region: Int32Array;
  sizes: number[];
  gap: number;
}

function luma(rgb: Buffer, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rgb[i * 3]! * 77 + rgb[i * 3 + 1]! * 150 + rgb[i * 3 + 2]! * 29) >> 8;
  return out;
}

/** 255, где a[i] не 0, — и наоборот: «выделено» для расстояния до края */
function invert(a: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ? 0 : 255;
  return out;
}

/** Залить связные по сторонам пиксели, где ok, начиная с seed; номер id — в region */
function flood(region: Int32Array, width: number, height: number, seed: number, id: number, ok: (i: number) => boolean, stack: Int32Array): number {
  let n = 0;
  let top = 0;
  const push = (i: number) => {
    if (region[i]! >= 0 || !ok(i)) return;
    region[i] = id;
    stack[top++] = i;
  };
  region[seed] = id;
  stack[top++] = seed;
  while (top) {
    const k = stack[--top]!;
    n++;
    const x = k % width;
    if (x > 0) push(k - 1);
    if (x < width - 1) push(k + 1);
    if (k >= width) push(k - width);
    if (k + width < width * height) push(k + width);
  }
  return n;
}

/** Разбить участок rect (rgb — его пиксели) на области между линиями */
export function lineMap(rgb: Buffer, rect: Rect, gap = 2): LineMap {
  const { width, height } = rect;
  const n = width * height;
  const gray = luma(rgb, n);
  const light = new Uint8Array(n);
  for (let i = 0; i < n; i++) light[i] = gray[i]! >= LINE ? 255 : 0;
  // Щели закрываются утолщением линий на gap: в области идут светлые пиксели дальше gap от линии
  const d = gap > 0 ? insideDistance(light, width, height) : null;
  const open = (i: number) => light[i]! > 0 && (!d || d[i]! > gap);
  const region = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const sizes: number[] = [];
  for (let s = 0; s < n; s++) {
    if (region[s]! >= 0 || !open(s)) continue;
    sizes.push(flood(region, width, height, s, sizes.length, open, stack));
  }
  return { rect, region, sizes, gap };
}

/** Маска на участке map.rect: 255 там, где b */
function local(b: Bitmap, rect: Rect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  const o = intersect(b.rect, rect);
  for (let y = o.y; y < o.y + o.height; y++) {
    const src = (y - b.rect.y) * b.rect.width - b.rect.x;
    const dst = (y - rect.y) * rect.width - rect.x;
    for (let x = o.x; x < o.x + o.width; x++) if (b.mask[src + x]! >= 128) out[dst + x] = 255;
  }
  return out;
}

/**
 * Привязать маску к линиям: область между линиями, которую маска покрывает почти целиком, берётся вся, едва задетая —
 * выбрасывается, а в протёкших через щель маска остаётся как была. Линии рядом со взятым становятся его контуром.
 * reach — у мазка кисти: доля области считается по нему, раздутому на reach, — почти накрыл клетку штриховки, и она вся.
 * Нарисованное кистью остаётся всегда: привязка мазка только добавляет.
 */
export function snapToLines(b: Bitmap, map: LineMap, reach = 0): Bitmap | null {
  const { rect, region, sizes, gap } = map;
  const { width, height } = rect;
  const n = width * height;
  const mask = local(b, rect);
  const ref = reach > 0 ? local(dilate({ rect, mask }, Math.round(reach), rect), rect) : mask;
  const inside = new Float64Array(sizes.length);
  for (let i = 0; i < n; i++) {
    const r = region[i]!;
    if (r >= 0 && ref[i]) inside[r] = inside[r]! + 1;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = region[i]!;
    if (r < 0) {
      if (reach > 0 && mask[i]) out[i] = 255;
      continue;
    }
    const cov = inside[r]! / sizes[r]!;
    if (cov >= WHOLE || (mask[i] && (reach > 0 || cov > STRAY))) out[i] = 255;
  }
  // Тёмное под маской, которое без разрыва примыкает к взятому, — тоже его: сплошь тёмное (кудри, чёрная одежда) — не
  // линия, и светлых областей, по которым его взять, в нём нет. Задетые маской штрихи соседей отделены от взятого светлым
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) if (out[i]) queue[tail++] = i;
  for (let head = 0; head < tail; head++) {
    const i = queue[head]!;
    const x = i % width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const j = i + dy * width + dx;
        if (nx < 0 || nx >= width || j < 0 || j >= n || out[j] || region[j]! >= 0 || !mask[j]) continue;
        out[j] = 255;
        queue[tail++] = j;
      }
    }
  }
  // Линии и щели рядом со взятым — его контур
  const toOut = insideDistance(invert(out), width, height);
  for (let i = 0; i < n; i++) if (region[i]! < 0 && !out[i] && toOut[i]! <= LINE_WIDTH + gap) out[i] = 255;
  return trim({ rect, mask: out });
}

/** Край маски шире (px > 0) или уже (px < 0) на |px| пикселей; null — сузилась в ничто */
export function changeEdge(b: Bitmap, px: number, bounds: Rect): Bitmap | null {
  const r = Math.round(Math.abs(px));
  if (!r) return b;
  if (px > 0) return trim(dilate(b, r, bounds));
  // Сужение — расстояние до края изнутри; за краем рамки маски её нет, поэтому рамка шире на пиксель пустоты
  const w = b.rect.width + 2;
  const h = b.rect.height + 2;
  const padded = new Uint8Array(w * h);
  for (let y = 0; y < b.rect.height; y++) padded.set(b.mask.subarray(y * b.rect.width, (y + 1) * b.rect.width), (y + 1) * w + 1);
  const d = insideDistance(padded, w, h);
  const mask = new Uint8Array(b.rect.width * b.rect.height);
  for (let y = 0; y < b.rect.height; y++) for (let x = 0; x < b.rect.width; x++) if (d[(y + 1) * w + x + 1]! > r) mask[y * b.rect.width + x] = 255;
  return trim({ rect: b.rect, mask });
}

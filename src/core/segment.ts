// Выделение объектов: SAM 2.1 от Meta (Apache 2.0) в onnxruntime-node, ONNX-сборка AnyLabeling.
// Кодировщик превращает участок холста в признаки — раз на участок, около секунды на WebGPU; декодер по точкам,
// рамке и прежней маске объекта даёт три маски разного охвата («деталь / часть / целое») за ~20 мс.
// Участок сжимается в 1024×1024 без сохранения пропорций, как у SAM 2. Итоги разведки — docs/recon-objects.md.
import ort from 'onnxruntime-node';
import sharp from 'sharp';
import type { Rect } from './frame.ts';

const SIZE = 1024;
/** Сторона масок декодера: логиты на сетке 256×256 поверх участка */
export const LOW = 256;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** Логит прежней маски для декодера: столько же уверенности, сколько у его собственных масок */
const HINT_LOGIT = 10;

/** Маска в координатах холста: rect и один канал 0/255 размером с него */
export interface Bitmap {
  rect: Rect;
  mask: Uint8Array;
}

/** Признаки участка холста */
export interface Embedding {
  crop: Rect;
  embed: ort.Tensor;
  f0: ort.Tensor;
  f1: ort.Tensor;
}

export interface SegmentPrompt {
  /** Точки в координатах холста: positive — объект здесь, иначе — здесь не объект */
  points?: { x: number; y: number; positive: boolean }[];
  /** Объект внутри этой рамки */
  box?: Rect;
  /** Прежняя маска объекта: подсказка, где он был */
  hint?: Bitmap;
  /** Где подсказка ничего не говорит (там правка поменяла пиксели): больше нуля — не знаем */
  unsure?: Bitmap;
}

/** Маска декодера: логиты LOW×LOW поверх участка crop (больше нуля — объект) и его оценка */
export interface Candidate {
  logits: Float32Array;
  score: number;
  crop: Rect;
}

export type Backend = 'webgpu' | 'cpu';

export class Segmenter {
  readonly backend: Backend;
  private readonly enc: ort.InferenceSession;
  private readonly dec: ort.InferenceSession;
  /** Сеансы ONNX зовутся строго по очереди */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(enc: ort.InferenceSession, dec: ort.InferenceSession, backend: Backend) {
    this.enc = enc;
    this.dec = dec;
    this.backend = backend;
  }

  /** Кодировщик — на WebGPU, если он есть (втрое быстрее, маски те же), иначе на процессоре; декодер всегда на процессоре */
  static async load(encoder: string, decoder: string, prefer: Backend = 'webgpu'): Promise<Segmenter> {
    const opts = (ep: Backend): ort.InferenceSession.SessionOptions => ({ executionProviders: [ep], logSeverityLevel: 3 });
    let backend: Backend = prefer;
    let enc: ort.InferenceSession;
    try {
      enc = await ort.InferenceSession.create(encoder, opts(prefer));
    } catch (err) {
      if (prefer === 'cpu') throw err;
      backend = 'cpu';
      enc = await ort.InferenceSession.create(encoder, opts('cpu'));
    }
    const dec = await ort.InferenceSession.create(decoder, opts('cpu'));
    return new Segmenter(enc, dec, backend);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Признаки участка crop; rgb — его пиксели, RGB размером с crop. shouldRun — ещё нужны ли они, когда подошла очередь */
  async encode(rgb: Buffer, crop: Rect, shouldRun?: () => boolean): Promise<Embedding> {
    const small = await sharp(rgb, { raw: { width: crop.width, height: crop.height, channels: 3 } })
      .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer();
    const input = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      for (let c = 0; c < 3; c++) input[c * SIZE * SIZE + i] = (small[i * 3 + c]! / 255 - MEAN[c]!) / STD[c]!;
    }
    const out = await this.serial(() => {
      if (shouldRun && !shouldRun()) throw new Error('Вид сменился');
      return this.enc.run({ image: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
    });
    return { crop, embed: out.image_embed!, f0: out.high_res_feats_0!, f1: out.high_res_feats_1! };
  }

  /** Три маски по подсказке. Декодер этой сборки принимает один набор подсказок за вызов */
  async decode(emb: Embedding, prompt: SegmentPrompt): Promise<Candidate[]> {
    const { crop } = emb;
    const pts: [number, number, number][] = (prompt.points ?? []).map((p) => [p.x, p.y, p.positive ? 1 : 0]);
    if (prompt.box) {
      const b = prompt.box;
      pts.push([b.x, b.y, 2], [b.x + b.width, b.y + b.height, 3]);
    }
    if (!pts.length) throw new Error('Нет подсказки для выделения');
    const coords = new Float32Array(pts.length * 2);
    const labels = new Float32Array(pts.length);
    pts.forEach(([x, y, l], i) => {
      coords[i * 2] = ((x - crop.x) / crop.width) * SIZE;
      coords[i * 2 + 1] = ((y - crop.y) / crop.height) * SIZE;
      labels[i] = l;
    });
    const hint = prompt.hint ? hintLogits(prompt.hint, crop, prompt.unsure) : new Float32Array(LOW * LOW);
    const out = await this.serial(() =>
      this.dec.run({
        image_embed: emb.embed,
        high_res_feats_0: emb.f0,
        high_res_feats_1: emb.f1,
        point_coords: new ort.Tensor('float32', coords, [1, pts.length, 2]),
        point_labels: new ort.Tensor('float32', labels, [1, pts.length]),
        mask_input: new ort.Tensor('float32', hint, [1, 1, LOW, LOW]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([prompt.hint ? 1 : 0]), [1]),
      }),
    );
    const masks = out.masks!;
    const [, k, h, w] = masks.dims as number[];
    if (h !== LOW || w !== LOW) throw new Error(`Декодер вернул маски ${w}×${h}, а не ${LOW}×${LOW}`);
    const data = masks.data as Float32Array;
    const scores = out.iou_predictions!.data as Float32Array;
    return Array.from({ length: k! }, (_, j) => {
      const logits = Float32Array.from(data.subarray(j * LOW * LOW, (j + 1) * LOW * LOW));
      cleanLogits(logits);
      return { logits, score: scores[j]!, crop };
    });
  }
}

/**
 * Прежняя маска на сетке LOW×LOW участка: доля объекта в клетке → логит от −HINT_LOGIT до +HINT_LOGIT.
 * Там, где unsure, подсказка нейтральна: объект мог вырасти туда или уйти оттуда — решает сама модель.
 */
export function hintLogits(hint: Bitmap, crop: Rect, unsure?: Bitmap): Float32Array {
  const out = new Float32Array(LOW * LOW);
  const at = (b: Bitmap, x: number, y: number, min: number) => {
    const lx = x - b.rect.x;
    const ly = y - b.rect.y;
    return lx >= 0 && ly >= 0 && lx < b.rect.width && ly < b.rect.height && b.mask[ly * b.rect.width + lx]! >= min;
  };
  const sub = 3;
  for (let gy = 0; gy < LOW; gy++) {
    for (let gx = 0; gx < LOW; gx++) {
      let score = 0;
      for (let sy = 0; sy < sub; sy++) {
        const y = Math.floor(crop.y + ((gy + (sy + 0.5) / sub) * crop.height) / LOW);
        for (let sx = 0; sx < sub; sx++) {
          const x = Math.floor(crop.x + ((gx + (sx + 0.5) / sub) * crop.width) / LOW);
          if (unsure && at(unsure, x, y, 1)) score += 0.5;
          else if (at(hint, x, y, 128)) score += 1;
        }
      }
      out[gy * LOW + gx] = ((2 * score) / (sub * sub) - 1) * HINT_LOGIT;
    }
  }
  return out;
}

/** Сколько клеток сетки внутри маски */
export function lowArea(c: Candidate): number {
  let n = 0;
  for (const v of c.logits) if (v > 0) n++;
  return n;
}

/** Пересечение двух масок на сетке, к объединению */
export function lowIou(a: Candidate, b: Candidate): number {
  let i = 0;
  let u = 0;
  for (let k = 0; k < LOW * LOW; k++) {
    const x = a.logits[k]! > 0;
    const y = b.logits[k]! > 0;
    if (x && y) i++;
    if (x || y) u++;
  }
  return u ? i / u : 0;
}

/** Дыра внутри маски меньше этой доли её площади заделывается: «шахматка» на штриховке, щели, но не проём арки */
const HOLE = 0.05;
/** Кусок маски меньше этой доли самого большого — крошка, его нет */
const ISLAND = 0.02;

/**
 * Чистка маски на сетке, на месте: декодер на штриховке и тонких линиях оставляет в объекте дыры клетками
 * и крошки вокруг. Мелкая дыра, не выходящая к краю участка, получает небольшой плюс, крошка — минус.
 * Куски объекта связны и по диагонали, дыры — только по сторонам клеток.
 */
export function cleanLogits(logits: Float32Array): void {
  const N = LOW * LOW;
  const comp = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  const sizes: number[] = [];
  const inside: boolean[] = [];
  const edge: boolean[] = [];
  for (let s = 0; s < N; s++) {
    if (comp[s]! >= 0) continue;
    const id = sizes.length;
    const on = logits[s]! > 0;
    let n = 0;
    let top = 0;
    let border = false;
    comp[s] = id;
    stack[top++] = s;
    while (top) {
      const k = stack[--top]!;
      n++;
      const x = k % LOW;
      const y = (k - x) / LOW;
      if (x === 0 || y === 0 || x === LOW - 1 || y === LOW - 1) border = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || (!on && dx && dy)) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= LOW || ny >= LOW) continue;
          const nb = ny * LOW + nx;
          if (comp[nb]! < 0 && (logits[nb]! > 0) === on) {
            comp[nb] = id;
            stack[top++] = nb;
          }
        }
      }
    }
    sizes.push(n);
    inside.push(on);
    edge.push(border);
  }
  let area = 0;
  let largest = 0;
  sizes.forEach((n, i) => {
    if (!inside[i]) return;
    area += n;
    largest = Math.max(largest, n);
  });
  if (!area) return;
  for (let k = 0; k < N; k++) {
    const id = comp[k]!;
    if (inside[id]) {
      if (sizes[id]! < ISLAND * largest) logits[k] = -1;
    } else if (!edge[id] && sizes[id]! <= HOLE * area) logits[k] = 1;
  }
}

/**
 * Уровни объекта под щелчком: маски от меньшей к большей, почти одинаковые — одной.
 * best — та, что выше всех оценил декодер: её показывать первой.
 */
export function levels(cands: Candidate[]): { levels: Candidate[]; best: number } {
  const top = cands.reduce((a, b) => (b.score > a.score ? b : a));
  const sorted = cands.filter((c) => lowArea(c) > 0).sort((a, b) => lowArea(a) - lowArea(b));
  const kept: Candidate[] = [];
  for (const c of sorted) {
    const same = kept.findIndex((k) => lowIou(k, c) > 0.92);
    if (same < 0) kept.push(c);
    else if (c.score > kept[same]!.score) kept[same] = c;
  }
  if (!kept.length) return { levels: [], best: 0 };
  const best = kept.findIndex((c) => c === top || lowIou(c, top) > 0.92);
  return { levels: kept, best: Math.max(0, best) };
}

/**
 * Маска в пикселях: логиты сетки растягиваются билинейно на участок в масштабе scale (1 — пиксели холста)
 * и режутся по нулю. Считается только около клеток объекта, результат обрезан по нему. null — маска пустая.
 * rect — в пикселях масштаба scale от начала холста.
 */
export function rasterize(c: Candidate, scale = 1, bounds?: Rect): Bitmap | null {
  const { logits, crop } = c;
  let gx0 = LOW;
  let gy0 = LOW;
  let gx1 = -1;
  let gy1 = -1;
  for (let gy = 0; gy < LOW; gy++) {
    for (let gx = 0; gx < LOW; gx++) {
      if (logits[gy * LOW + gx]! <= 0) continue;
      if (gx < gx0) gx0 = gx;
      if (gx > gx1) gx1 = gx;
      if (gy < gy0) gy0 = gy;
      gy1 = gy;
    }
  }
  if (gx1 < 0) return null;
  // Участок в масштабе scale; объект — в клетках gx0..gx1 и на клетку вокруг
  const W = crop.width * scale;
  const H = crop.height * scale;
  const ox = crop.x * scale;
  const oy = crop.y * scale;
  let x0 = Math.max(0, Math.floor(((gx0 - 1) * W) / LOW));
  let y0 = Math.max(0, Math.floor(((gy0 - 1) * H) / LOW));
  let x1 = Math.min(Math.round(W), Math.ceil(((gx1 + 2) * W) / LOW));
  let y1 = Math.min(Math.round(H), Math.ceil(((gy1 + 2) * H) / LOW));
  if (bounds) {
    x0 = Math.max(x0, Math.floor(bounds.x * scale - ox));
    y0 = Math.max(y0, Math.floor(bounds.y * scale - oy));
    x1 = Math.min(x1, Math.ceil((bounds.x + bounds.width) * scale - ox));
    y1 = Math.min(y1, Math.ceil((bounds.y + bounds.height) * scale - oy));
  }
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  const out = new Uint8Array(w * h);
  let mx0 = w;
  let my0 = h;
  let mx1 = -1;
  let my1 = -1;
  // Те же координаты, что у билинейного растяжения сетки на весь участок (align_corners = false)
  const xs = new Float32Array(w);
  const xi = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const sx = Math.min(LOW - 1, Math.max(0, ((x0 + x + 0.5) * LOW) / W - 0.5));
    xi[x] = Math.floor(sx);
    xs[x] = sx - xi[x]!;
  }
  for (let y = 0; y < h; y++) {
    const sy = Math.min(LOW - 1, Math.max(0, ((y0 + y + 0.5) * LOW) / H - 0.5));
    const r0 = Math.floor(sy);
    const r1 = Math.min(LOW - 1, r0 + 1);
    const fy = sy - r0;
    for (let x = 0; x < w; x++) {
      const c0 = xi[x]!;
      const c1 = Math.min(LOW - 1, c0 + 1);
      const fx = xs[x]!;
      const top = logits[r0 * LOW + c0]! * (1 - fx) + logits[r0 * LOW + c1]! * fx;
      const bottom = logits[r1 * LOW + c0]! * (1 - fx) + logits[r1 * LOW + c1]! * fx;
      if (top * (1 - fy) + bottom * fy <= 0) continue;
      out[y * w + x] = 255;
      if (x < mx0) mx0 = x;
      if (x > mx1) mx1 = x;
      if (y < my0) my0 = y;
      my1 = y;
    }
  }
  if (mx1 < 0) return null;
  const tw = mx1 - mx0 + 1;
  const th = my1 - my0 + 1;
  const mask = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) mask.set(out.subarray((my0 + y) * w + mx0, (my0 + y) * w + mx0 + tw), y * tw);
  return { rect: { x: Math.round(ox) + x0 + mx0, y: Math.round(oy) + y0 + my0, width: tw, height: th }, mask };
}

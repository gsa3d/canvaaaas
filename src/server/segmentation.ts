// Выделение объектов на сервере: модель SAM (веса скачиваются по просьбе пользователя), признаки видимой части холста,
// объект под курсором и под щелчком с его уровнями, второй проход для мелких объектов.
// Признаки считаются по видимой части, а не по всей картинке: на 6000×4000 целиком края объектов становятся кашей.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { CanvasDocument } from '../core/document.ts';
import { intersect, type Rect } from '../core/frame.ts';
import { changeEdge, lineMap, snapToLines } from '../core/lines.ts';
import { area, clipBitmap, clipOut, clipScaled, overlap, unionBitmap } from '../core/objects.ts';
import { levels, LOW, rasterize, Segmenter, type Backend, type Bitmap, type Candidate, type Embedding, type SegmentPrompt } from '../core/segment.ts';
import { installModel, modelFiles, modelInstalled } from '../core/segment-model.ts';
import { OUTSIDE_LAYER, type MaskResult, type PickRequest, type PickResult, type RectDto, type SegmentDto, type SegmentPoint } from '../shared/api.ts';

const EMBEDDINGS_KEPT = 4;
const MASKS_KEPT = 300;
/** Признаки участка годятся для другого, если участки почти совпадают */
const SAME_CROP = 0.85;
/** Второй проход — для объекта меньше этой доли участка: признаки считаются заново вокруг него */
const REFINE_BELOW = 0.45;
/** Подсветка под курсором — не больше этого по большей стороне */
const HOVER_MAX = 1600;
/** Уровень заметно меняет выделение, если добавляет (или вычитает) хотя бы такую свою долю */
const CHANGES = 0.25;
/** Маска с рамкой шире берётся, если совпадает с изменённым моделью хуже не больше чем на столько */
const WIDER_WORSE = 0.02;

interface CachedEmbedding {
  docId: string;
  rev: number;
  crop: Rect;
  emb: Promise<Embedding>;
}

interface StoredMask {
  bitmap: Bitmap;
  /** С какой подсказкой и на каком участке маска найдена — для второго прохода */
  points: SegmentPoint[];
  box?: Rect;
  crop: Rect;
  refined: boolean;
  /** Где искали объект */
  scope?: Scope;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function iou(a: Rect, b: Rect): number {
  const i = intersect(a, b);
  const inter = i.width * i.height;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Рамка шире на pad с каждой стороны, в целых пикселях внутри холста */
function grow(r: Rect, pad: number, doc: { width: number; height: number }): Rect {
  const x = Math.max(0, Math.floor(r.x - pad));
  const y = Math.max(0, Math.floor(r.y - pad));
  return { x, y, width: Math.min(doc.width, Math.ceil(r.x + r.width + pad)) - x, height: Math.min(doc.height, Math.ceil(r.y + r.height + pad)) - y };
}

function best(cands: Candidate[]): Candidate {
  return cands.reduce((a, b) => (b.score > a.score ? b : a));
}

export class Segmentation {
  private readonly changed: () => void;
  private status: SegmentDto['status'];
  private progress: number | undefined;
  private error: string | undefined;
  private backend: Backend | undefined;
  private model: Promise<Segmenter> | null = null;
  private embeddings: CachedEmbedding[] = [];
  private readonly masks = new Map<string, StoredMask>();
  /** Сколько пересчётов масок объектов после правок идёт */
  private following = 0;
  /** Вид меняется быстрее, чем считаются признаки: считаем только последний */
  private viewSeq = 0;

  constructor(changed: () => void) {
    this.changed = changed;
    this.status = modelInstalled() ? 'ready' : 'missing';
  }

  state(): SegmentDto {
    return { status: this.status, progress: this.progress, error: this.error, backend: this.backend, following: this.following > 0 };
  }

  /** Скачать веса модели; ход скачивания — в state() */
  install(): void {
    if (this.status === 'downloading' || modelInstalled()) return;
    this.status = 'downloading';
    this.progress = 0;
    this.error = undefined;
    this.changed();
    installModel({
      onProgress: (f) => {
        this.progress = f;
        this.changed();
      },
    })
      .then(() => {
        this.status = 'ready';
        this.progress = undefined;
        this.changed();
        return this.segmenter();
      })
      .catch((err: unknown) => {
        this.status = 'error';
        this.error = `Не удалось скачать модель: ${message(err)}`;
        this.changed();
      });
  }

  private segmenter(): Promise<Segmenter> {
    if (!modelInstalled()) return Promise.reject(new Error('Модель выделения объектов не скачана'));
    if (!this.model) {
      this.status = 'loading';
      this.changed();
      const { encoder, decoder } = modelFiles();
      this.model = Segmenter.load(encoder, decoder).then(
        (s) => {
          this.status = 'ready';
          this.backend = s.backend;
          this.error = undefined;
          this.changed();
          return s;
        },
        (err: unknown) => {
          this.model = null;
          this.status = 'error';
          this.error = `Модель не загрузилась: ${message(err)}`;
          this.changed();
          throw err;
        },
      );
    }
    return this.model;
  }

  /**
   * Признаки участка холста; годятся и признаки почти того же участка, посчитанные раньше, если в нём лежит need
   * (точки и рамка подсказки). view — признаки видимой части: если вид сменился, пока они ждали очереди, их уже не считаем.
   */
  private async embedding(doc: CanvasDocument, crop: Rect, opts: { view?: boolean; need?: Rect } = {}): Promise<Embedding> {
    const { view = false, need } = opts;
    const hit = this.embeddings.find(
      (e) => e.docId === doc.id && e.rev === doc.rev && iou(e.crop, crop) >= SAME_CROP && (!need || contains(e.crop, need)),
    );
    if (hit) {
      this.embeddings = [hit, ...this.embeddings.filter((e) => e !== hit)];
      // Признаки лежат в потоке модели: там они тоже свежие, иначе выбросились бы раньше, чем здесь
      hit.emb.then((e) => this.model?.then((s) => s.touch(e))).catch(() => undefined);
      return hit.emb;
    }
    const seq = view ? ++this.viewSeq : 0;
    const rgb = doc.region(crop);
    const entry: CachedEmbedding = {
      docId: doc.id,
      rev: doc.rev,
      crop,
      emb: this.segmenter().then((s) => s.encode(rgb, crop, view ? () => seq === this.viewSeq : undefined)),
    };
    entry.emb.catch(() => {
      this.embeddings = this.embeddings.filter((e) => e !== entry);
    });
    this.embeddings = [entry, ...this.embeddings].slice(0, EMBEDDINGS_KEPT);
    return entry.emb;
  }

  /** Видимая часть холста целыми пикселями; слишком маленькая — с запасом вокруг */
  private viewRect(doc: CanvasDocument, view: RectDto): Rect {
    const min = 256;
    const cx = view.x + view.width / 2;
    const cy = view.y + view.height / 2;
    const w = Math.max(view.width, min);
    const h = Math.max(view.height, min);
    const r = grow({ x: cx - w / 2, y: cy - h / 2, width: w, height: h }, 0, doc);
    if (r.width < 16 || r.height < 16) throw new Error('Вид за краем холста');
    return r;
  }

  /** Посчитать признаки видимой части заранее, чтобы подсветка и щелчок были сразу */
  async prepare(doc: CanvasDocument, view: RectDto): Promise<void> {
    await this.embedding(doc, this.viewRect(doc, view), { view: true });
  }

  /**
   * Подсветка объекта под курсором: маска в масштабе не больше HOVER_MAX и где она лежит на холсте; null — ничего.
   * scope — где ищет палочка: подсвечивается только то, что там
   */
  async hover(doc: CanvasDocument, view: RectDto, x: number, y: number, scope?: Scope): Promise<{ png: Buffer; rect: RectDto } | null> {
    const crop = this.viewRect(doc, view);
    if (x < crop.x || y < crop.y || x >= crop.x + crop.width || y >= crop.y + crop.height) return null;
    const emb = await this.embedding(doc, crop, { view: true, need: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } });
    const lv = levels(await (await this.segmenter()).decode(emb, { points: [{ x, y, positive: true }] }));
    const c = lv.levels[lv.best];
    if (!c) return null;
    const k = Math.min(1, HOVER_MAX / Math.max(crop.width, crop.height));
    const raw = rasterize(c, k);
    const b = raw && scope ? scoped(raw, scope, k) : raw;
    if (!b) return null;
    return {
      png: await maskPng(b),
      rect: { x: b.rect.x / k, y: b.rect.y / k, width: b.rect.width / k, height: b.rect.height / k },
    };
  }

  /**
   * Объект по точкам и (или) рамке: его уровни от мелкого к крупному, каждый — маской с id.
   * selection — выделение одной маской, если объект к нему добавят или из него вычтут (req.op): тогда первым идёт уровень,
   * который его заметно меняет, — иначе щелчок рядом с выделенным давал бы крупный уровень, который уже весь в нём.
   * scope — где ищет палочка: уровни обрезаются по нему, одинаковые после этого сливаются
   */
  async pick(doc: CanvasDocument, req: PickRequest, selection?: Bitmap, scope?: Scope): Promise<Omit<PickResult, 'owner' | 'enter'>> {
    const points = req.points ?? [];
    const box = req.box && intersect(req.box, { x: 0, y: 0, width: doc.width, height: doc.height });
    if (!points.length && !box?.width) throw new Error('Нет подсказки для выделения');
    // Точки прежнего вида (Shift и Alt после прокрутки) тоже должны попасть в участок
    let crop = this.viewRect(doc, req.view);
    const need = [...points.map((p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), width: 1, height: 1 })), ...(box?.width ? [box] : [])].reduce(union);
    if (!contains(crop, need)) {
      const all = union(crop, need);
      crop = grow(all, 0.05 * Math.max(all.width, all.height), doc);
    }
    const emb = await this.embedding(doc, crop, { view: true, need });
    const cands = await (await this.segmenter()).decode(emb, { points, box });
    // У рамки и нескольких точек объект один: берём лучшую маску, у одного щелчка — все уровни
    const lv = points.length === 1 && !box ? levels(cands) : { levels: [best(cands)], best: 0 };
    const bounds = { x: 0, y: 0, width: doc.width, height: doc.height };
    let found = lv.levels.flatMap((c, i) => {
      const bitmap = rasterize(c, 1, bounds);
      return bitmap ? [{ bitmap, best: i === lv.best }] : [];
    });
    if (!found.length) throw new Error('Здесь объект не нашёлся');
    if (req.snap) {
      const snapped = this.snap(doc, found.map((f) => f.bitmap));
      found = found.map((f, i) => ({ ...f, bitmap: snapped[i]! }));
    }
    if (scope) {
      found = found.flatMap((f) => {
        const bitmap = scoped(f.bitmap, scope);
        return bitmap ? [{ ...f, bitmap }] : [];
      });
      if (!found.length) throw new Error(OUTSIDE_LAYER);
      found = dedupe(found);
    }
    const bitmaps = found.map((f) => f.bitmap);
    let level = Math.max(0, found.findIndex((f) => f.best));
    let unchanged = false;
    if (selection && (req.op === 'add' || req.op === 'sub')) {
      // Доля уровня, которая уже в выделении. Если уровень его не меняет, берётся ближайший мельче, который меняет:
      // крупнее — нельзя, щелчок внутри выделенного иначе добавлял бы весь фон вокруг
      const shared = bitmaps.map((b) => overlap(b, selection) / Math.max(1, area(b)));
      const change = shared.map((s) => (req.op === 'add' ? 1 - s : s));
      const enough = req.op === 'add' ? CHANGES : 0.02;
      if (change[level]! < enough) {
        const smaller = change.slice(0, level).flatMap((c, i) => (c >= enough ? [i] : []));
        if (smaller.length) level = smaller.at(-1)!;
        else unchanged = change[level]! < 0.02;
      }
    }
    return {
      levels: bitmaps.map((bitmap) => ({ id: this.store({ bitmap, points, box, crop, refined: false, scope }), rect: bitmap.rect })),
      level,
      unchanged: unchanged || undefined,
    };
  }

  /**
   * Маски, привязанные к линиям рисунка: край — по линиям, а не по клеткам сетки модели, контур входит в маску.
   * Участок с линиями один на все маски — с запасом вокруг них. reach — радиус кисти, если это мазок
   */
  snap(doc: CanvasDocument, bitmaps: Bitmap[], reach = 0): Bitmap[] {
    const all = bitmaps.map((b) => b.rect).reduce(union);
    // У мазка — с запасом в несколько кистей: клетка штриховки, которую он задел, должна попасть в участок целиком
    const rect = grow(all, Math.max(24, 0.15 * Math.max(all.width, all.height), 6 * reach), doc);
    const map = lineMap(doc.region(rect), rect);
    return bitmaps.map((b) => snapToLines(b, map, reach) ?? b);
  }

  /**
   * Объект на картинке, которой на холсте нет целиком (ответ модели у версии): rgb — её пиксели размером с rect,
   * box — рамка подсказки на холсте. Признаки — одноразовые, мимо кэша участков холста. fit — что модель поменяла
   * (changed, внутри seen — того, что от версии видно): из масок разного охвата берётся та, что лучше с этим совпадает,
   * без fit — лучшая по оценке декодера. Объект, упёршийся в рамку, модель нарисовала крупнее, чем видно: с fit рамка
   * до двух раз шире в ту сторону, пока маска с ней совпадает с изменённым не хуже (с широкой рамкой SAM, бывает,
   * отдаёт фон вокруг объекта). Мелкий для картинки объект ищется второй раз вокруг себя, как у refine. snap — край по
   * линиям этой же картинки. null — объекта нет
   */
  async objectOn(rgb: Buffer, rect: Rect, opts: { box: Rect; snap: boolean; fit?: { changed: Bitmap; seen: Bitmap } }): Promise<Bitmap | null> {
    const s = await this.segmenter();
    const { fit } = opts;
    const score = (b: Bitmap, decoder: number) => {
      if (!fit) return decoder;
      const common = overlap(b, fit.changed);
      return common / (overlap(b, fit.seen) + area(fit.changed) - common);
    };
    const find = async (emb: Embedding, prompt: Rect) => {
      const found = (await s.decode(emb, { box: prompt })).flatMap((c) => {
        const b = rasterize(c, 1, rect);
        return b ? [{ b, score: score(b, c.score) }] : [];
      });
      return found.length ? found.reduce((a, f) => (f.score > a.score ? f : a)) : null;
    };
    const inside = (r: Rect, pad: number) => intersect(grow(r, pad, { width: rect.x + rect.width, height: rect.y + rect.height }), rect);
    const padOf = (r: Rect, k: number) => Math.max(16, k * Math.max(r.width, r.height));
    const whole = await s.encode(rgb, rect);
    // Рамка с запасом: целый объект в неё не упирается
    let prompt = inside(opts.box, padOf(opts.box, 0.1));
    let top = await find(whole, prompt);
    for (let i = 0; top && fit && i < 2; i++) {
      const wider = widen(prompt, top.b.rect, rect, padOf(prompt, 0.25));
      if (!wider) break;
      const next = await find(whole, wider);
      if (!next || next.score < top.score - WIDER_WORSE) break;
      prompt = wider;
      top = next;
    }
    if (!top) return null;
    let b = top.b;
    const side = Math.max(b.rect.width, b.rect.height);
    if (side < REFINE_BELOW * Math.max(rect.width, rect.height)) {
      const crop = inside(b.rect, Math.max(32, 0.4 * side));
      b = (await find(await s.encode(cut(rgb, rect, crop), crop), inside(b.rect, padOf(b.rect, 0.03))))?.b ?? b;
    }
    if (!opts.snap) return b;
    const around = inside(b.rect, Math.max(24, 0.15 * Math.max(b.rect.width, b.rect.height)));
    const snapped = snapToLines(b, lineMap(cut(rgb, rect, around), around));
    // Линии правят только край: толстый тёмный штрих внутри объекта — линия, и без этого стал бы в маске дырой
    const core = changeEdge(b, -2 * (Math.max(rect.width, rect.height) / LOW), rect);
    return snapped && core ? unionBitmap(snapped, core) : (snapped ?? b);
  }

  /** Сохранить готовую маску выделения (край, мазок): её id — для фигуры kind: 'mask' */
  keep(bitmap: Bitmap): MaskResult {
    return { id: this.store({ bitmap, points: [], crop: bitmap.rect, refined: true }), rect: bitmap.rect };
  }

  /**
   * Второй проход: если объект мелкий для участка, на котором его нашли, признаки считаются заново вокруг него
   * (+40% с каждой стороны) и маска уточняется по тем же точкам и его рамке. Крупный — та же маска.
   */
  async refine(doc: CanvasDocument, id: string, snap = false): Promise<MaskResult> {
    const stored = this.stored(id);
    const b = stored.bitmap;
    const side = Math.max(b.rect.width, b.rect.height);
    if (stored.refined || side >= REFINE_BELOW * Math.max(stored.crop.width, stored.crop.height)) return { id, rect: b.rect };
    const crop = grow(b.rect, Math.max(32, 0.4 * side), doc);
    const emb = await this.embedding(doc, crop, { need: b.rect });
    const c = best(await (await this.segmenter()).decode(emb, { points: stored.points, box: b.rect }));
    const raw = rasterize(c, 1, { x: 0, y: 0, width: doc.width, height: doc.height });
    if (!raw) return { id, rect: b.rect };
    const snapped = snap ? this.snap(doc, [raw])[0]! : raw;
    const bitmap = stored.scope ? scoped(snapped, stored.scope) : snapped;
    if (!bitmap) return { id, rect: b.rect };
    return { id: this.store({ ...stored, bitmap, crop, refined: true }), rect: bitmap.rect };
  }

  private store(mask: StoredMask): string {
    const id = randomUUID();
    this.masks.set(id, mask);
    while (this.masks.size > MASKS_KEPT) this.masks.delete(this.masks.keys().next().value!);
    return id;
  }

  private stored(id: string): StoredMask {
    const m = this.masks.get(id);
    if (!m) throw new Error('Выделение устарело: выделите объект заново');
    return m;
  }

  /** Маска объекта под щелчком */
  bitmap(id: string): Bitmap {
    return this.stored(id).bitmap;
  }
}

/**
 * Рамка шире на by с тех сторон, где в неё упёрся объект found (на клетку сетки модели над rect), но не за rect;
 * null — не упёрся
 */
function widen(box: Rect, found: Rect, rect: Rect, by: number): Rect | null {
  const near = 1.5 * (Math.max(rect.width, rect.height) / LOW);
  const x0 = found.x - box.x <= near && box.x > rect.x ? Math.max(rect.x, box.x - by) : box.x;
  const y0 = found.y - box.y <= near && box.y > rect.y ? Math.max(rect.y, box.y - by) : box.y;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const x1 = right - (found.x + found.width) <= near && right < rect.x + rect.width ? Math.min(rect.x + rect.width, right + by) : right;
  const y1 = bottom - (found.y + found.height) <= near && bottom < rect.y + rect.height ? Math.min(rect.y + rect.height, bottom + by) : bottom;
  if (x0 === box.x && y0 === box.y && x1 === right && y1 === bottom) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Пиксели участка part из RGB картинки размером с rect */
function cut(rgb: Buffer, rect: Rect, part: Rect): Buffer {
  if (part.x === rect.x && part.y === rect.y && part.width === rect.width && part.height === rect.height) return rgb;
  const out = Buffer.alloc(part.width * part.height * 3);
  for (let y = 0; y < part.height; y++) {
    const from = ((part.y - rect.y + y) * rect.width + part.x - rect.x) * 3;
    rgb.copy(out, y * part.width * 3, from, from + part.width * 3);
  }
  return out;
}

/** Где ищет палочка: в слое, где работают, или на фоне — всё, кроме видимых слоёв */
export type Scope = { layer: Bitmap } | { outside: Bitmap[] };

/** Маска в пределах scope; k — масштаб маски от холста (у подсветки под курсором) */
function scoped(b: Bitmap, scope: Scope, k = 1): Bitmap | null {
  if ('outside' in scope) return clipOut(b, scope.outside, k);
  return k === 1 ? clipBitmap(b, scope.layer) : clipScaled(b, scope.layer, k);
}

/** Уровни, обрезанные по слою, часто совпадают (часть и целое — весь слой): из почти одинаковых остаётся мельчайший */
function dedupe<T extends { bitmap: Bitmap; best: boolean }>(found: T[]): T[] {
  const out: T[] = [];
  for (const f of found) {
    const prev = out.at(-1);
    const a = area(f.bitmap);
    if (prev && Math.abs(a - area(prev.bitmap)) <= 0.01 * a && overlap(prev.bitmap, f.bitmap) >= 0.99 * a) {
      if (f.best) prev.best = true;
      continue;
    }
    out.push(f);
  }
  return out;
}

/** Маска для браузера: белая, прозрачная там, где её нет (серый с альфой) */
export function maskPng(b: Bitmap, max = Infinity): Promise<Buffer> {
  const { width, height } = b.rect;
  const ga = Buffer.alloc(width * height * 2);
  for (let i = 0; i < width * height; i++) {
    ga[i * 2] = 255;
    ga[i * 2 + 1] = b.mask[i]!;
  }
  let img = sharp(ga, { raw: { width, height, channels: 2 } });
  const k = Math.min(1, max / Math.max(width, height));
  if (k < 1) img = img.resize(Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k)), { fit: 'fill', kernel: 'linear' });
  return img.png({ compressionLevel: 2 }).toBuffer();
}

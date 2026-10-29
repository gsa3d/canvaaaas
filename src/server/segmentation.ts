// Выделение объектов на сервере: модель SAM (веса скачиваются по просьбе пользователя), признаки видимой части холста,
// объект под курсором и под щелчком с его уровнями, второй проход для мелких объектов и пересчёт масок объектов после правки.
// Признаки считаются по видимой части, а не по всей картинке: на 6000×4000 целиком края объектов становятся кашей.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { CanvasDocument, DocObject } from '../core/document.ts';
import { intersect, type Rect } from '../core/frame.ts';
import { area, changedPixels, touchedEdge } from '../core/objects.ts';
import { levels, rasterize, Segmenter, type Backend, type Bitmap, type Candidate, type Embedding, type SegmentPrompt } from '../core/segment.ts';
import { installModel, modelFiles, modelInstalled } from '../core/segment-model.ts';
import type { PickRequest, PickResult, RectDto, SegmentDto, SegmentPoint } from '../shared/api.ts';

const EMBEDDINGS_KEPT = 4;
const MASKS_KEPT = 300;
/** Признаки участка годятся для другого, если участки почти совпадают */
const SAME_CROP = 0.85;
/** Второй проход — для объекта меньше этой доли участка: признаки считаются заново вокруг него */
const REFINE_BELOW = 0.45;
/** Подсветка под курсором — не больше этого по большей стороне */
const HOVER_MAX = 1600;

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

  /** Подсветка объекта под курсором: маска в масштабе не больше HOVER_MAX и где она лежит на холсте; null — ничего */
  async hover(doc: CanvasDocument, view: RectDto, x: number, y: number): Promise<{ png: Buffer; rect: RectDto } | null> {
    const crop = this.viewRect(doc, view);
    if (x < crop.x || y < crop.y || x >= crop.x + crop.width || y >= crop.y + crop.height) return null;
    const emb = await this.embedding(doc, crop, { view: true, need: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } });
    const lv = levels(await (await this.segmenter()).decode(emb, { points: [{ x, y, positive: true }] }));
    const c = lv.levels[lv.best];
    if (!c) return null;
    const k = Math.min(1, HOVER_MAX / Math.max(crop.width, crop.height));
    const b = rasterize(c, k);
    if (!b) return null;
    return {
      png: await maskPng(b),
      rect: { x: b.rect.x / k, y: b.rect.y / k, width: b.rect.width / k, height: b.rect.height / k },
    };
  }

  /** Объект по точкам и (или) рамке: его уровни от мелкого к крупному, каждый — маской с id */
  async pick(doc: CanvasDocument, req: PickRequest): Promise<PickResult> {
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
    const out: PickResult = { levels: [], level: 0 };
    lv.levels.forEach((c, i) => {
      const bitmap = rasterize(c, 1, bounds);
      if (!bitmap) return;
      if (i === lv.best) out.level = out.levels.length;
      out.levels.push({ id: this.store({ bitmap, points, box, crop, refined: false }), rect: bitmap.rect });
    });
    if (!out.levels.length) throw new Error('Здесь объект не нашёлся');
    return out;
  }

  /**
   * Второй проход: если объект мелкий для участка, на котором его нашли, признаки считаются заново вокруг него
   * (+40% с каждой стороны) и маска уточняется по тем же точкам и его рамке. Крупный — та же маска.
   */
  async refine(doc: CanvasDocument, id: string): Promise<{ id: string; rect: RectDto }> {
    const stored = this.stored(id);
    const b = stored.bitmap;
    const side = Math.max(b.rect.width, b.rect.height);
    if (stored.refined || side >= REFINE_BELOW * Math.max(stored.crop.width, stored.crop.height)) return { id, rect: b.rect };
    const crop = grow(b.rect, Math.max(32, 0.4 * side), doc);
    const emb = await this.embedding(doc, crop, { need: b.rect });
    const c = best(await (await this.segmenter()).decode(emb, { points: stored.points, box: b.rect }));
    const bitmap = rasterize(c, 1, { x: 0, y: 0, width: doc.width, height: doc.height });
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

  /**
   * Маски объектов после правки участка region: before и after — его пиксели до и после (RGB).
   * Пересчитываются объекты, чей край правка задела: по рамке старой маски вместе с тем, что модель изменила рядом,
   * и самой старой маской как подсказкой там, где пиксели те же (так бант гуся уходит из маски, IoU 0,97 с новым щелчком).
   * null — объект не нашёлся. Объекты, которых правка не коснулась, в ответ не попадают.
   */
  async remask(doc: CanvasDocument, objects: DocObject[], region: Rect, before: Buffer, after: Buffer): Promise<Map<string, Bitmap | null>> {
    const out = new Map<string, Bitmap | null>();
    const touched = objects.filter((o) => intersect(o.rect, region).width > 0 && intersect(o.rect, region).height > 0);
    if (!touched.length || !modelInstalled()) return out;
    const changed = changedPixels(before, after, region.width, region.height);
    const bounds = { x: 0, y: 0, width: doc.width, height: doc.height };
    this.following++;
    this.changed();
    try {
      for (const obj of touched) {
        const edge = touchedEdge(obj, changed, region);
        if (!edge) continue;
        // Объект мог вырасти: в рамку идёт и то, что правка изменила рядом с ним (в пределах четверти его размера)
        const near = grow(obj.rect, 0.25 * Math.max(obj.rect.width, obj.rect.height), doc);
        const grown = changedBox(changed, region, intersect(near, region));
        const target = grown ? union(obj.rect, grown) : obj.rect;
        const box = grow(target, 0.08 * Math.max(target.width, target.height), doc);
        const crop = grow(box, Math.max(32, 0.25 * Math.max(box.width, box.height)), doc);
        const emb = await this.embedding(doc, crop, { need: box });
        // Где правка поменяла пиксели, прежняя маска не подсказка: объект мог туда вырасти или оттуда уйти
        const c = best(await (await this.segmenter()).decode(emb, { box, hint: obj, unsure: { rect: region, mask: changed } }));
        const bitmap = rasterize(c, 1, bounds);
        out.set(obj.id, bitmap && area(bitmap) >= 0.02 * area(obj) ? bitmap : null);
      }
    } finally {
      this.following--;
      this.changed();
    }
    return out;
  }
}

/** Рамка изменённых пикселей участка region внутри within; null — их там нет */
function changedBox(changed: Uint8Array, region: Rect, within: Rect): Rect | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = within.y; y < within.y + within.height; y++) {
    const row = (y - region.y) * region.width - region.x;
    for (let x = within.x; x < within.x + within.width; x++) {
      if (!changed[row + x]) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return x1 < x0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
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

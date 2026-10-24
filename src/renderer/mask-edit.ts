// Правка маски слоя или задачи прямо в браузере. Сервер присылает участок холста под слоем, слои над ним,
// ответ модели на весь кусок и маску — в размере превью, а браузер сам смешивает их по маске с той же
// растушёвкой, что у сервера. Поэтому под ластиком фон открывается сразу, пока мазок ещё рисуется, а когда
// сервер пересчитает настоящий холст, картинка не меняется. Это только показ: пиксели холста считает сервер.
import { featherAlpha, MASK_THRESHOLD } from '../core/mask.ts';
import { API_HEADER, type MaskEditResult, type MaskShape, type RectDto } from '../shared/api.ts';

export interface MaskEditView {
  kind: 'layer' | 'job';
  /** id слоя или задачи */
  target: string;
  /** Где кусок лежит на холсте */
  rect: RectDto;
  /** Растушёвка внутрь маски, пиксели холста */
  feather: number;
  /** Картинки участка; новый адрес — картинка поменялась и её надо перезапросить */
  below: string;
  above: string;
  layer: string;
  mask: string;
}

type Rect = RectDto;

/** Мазок, который рисуется сейчас: покрытие копится в canvas покрытия, box — где оно есть */
interface Stroke {
  erase: boolean;
  box: Rect | null;
  /** У кисти — отпечаток, шаг между отпечатками и где лёг последний */
  brush?: { sprite: HTMLCanvasElement; spacing: number; last: [number, number] };
}

function union(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Функция ошибок (Абрамовиц и Стиган 7.1.26): для профиля мягкой кисти точности с запасом */
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x < 0 ? -y : y;
}

/**
 * Отпечаток кисти — непрозрачный квадрат, где яркость — покрытие. Сервер рисует мягкий мазок линией уже
 * на половину зоны затухания с размытием σ = зона/5 (mask-shapes.ts); поперёк такой линии покрытие —
 * нормальное распределение, его и повторяет отпечаток. Отпечатки кладутся режимом lighten: берётся
 * наибольшее покрытие, а не сумма, как у одного сплошного мазка.
 */
function brushSprite(size: number, fade: number, soft: boolean): HTMLCanvasElement {
  const r = size / 2;
  const n = Math.ceil(2 * (r + fade * 0.1) + 4);
  const half = n / 2;
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const core = (size - fade) / 2;
  const sigma = fade / 5;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - half, y + 0.5 - half);
      const v = soft ? 0.5 * (1 + erf((core - d) / (sigma * Math.SQRT2))) : Math.min(1, Math.max(0, r - d + 0.5));
      const i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(v * 255);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

async function fetchImage(url: string): Promise<{ bitmap: ImageBitmap; version: number }> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Ошибка ${res.status}`);
  }
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  return { bitmap, version: Number(res.headers.get(`${API_HEADER}-version`)) };
}

export class MaskPreview {
  view: MaskEditView;
  /** Картинки пришли — превью можно показывать и рисовать по нему */
  ready = false;
  /** Мазки, ушедшие на сервер, ответа на которые ещё нет */
  inflight = 0;
  /** rev из ответа на последний мазок: пока холст (или слой задачи) его не догнал, превью ещё нужно */
  settleRev = 0;

  private width = 0;
  private height = 0;
  private below: ImageBitmap | null = null;
  private above: ImageBitmap | null = null;
  /** Ответ модели, альфа — растушёванная маска с текущим мазком */
  private readonly layer = document.createElement('canvas');
  private layerPx: ImageData | null = null;
  /** Где маска больше половины: по нему рисуется контур */
  private readonly hard = document.createElement('canvas');
  /**
   * Копии слоя и контура на момент последнего пересчёта. canvas, в который пишут putImageData, браузер
   * заново выгружает в видеопамять на каждом кадре; копию — нет, поэтому картинка двигается плавно.
   * Пока водят кистью, копия отстаёт, и рисуется сам canvas.
   */
  private snapshot: { layer: ImageBitmap; hard: ImageBitmap; version: number } | null = null;
  /** Растёт при каждом пересчёте превью */
  private version = 0;
  /** Покрытие текущего мазка, в канале R */
  private readonly coverage = document.createElement('canvas');
  /** Маска до растушёвки, со всеми законченными мазками */
  private mask: Uint8Array | null = null;
  private loaded = { below: '', above: '', layer: '' };
  /** Маска на сервере могла стать другой (отмена, мазок не дошёл): перезапросить, когда мазков в пути не будет */
  private stale = false;
  /** Число мазков: если, пока шла маска с сервера, был новый, она уже устарела */
  private strokes = 0;
  private loading = false;
  private failed = false;
  private disposed = false;
  private stroke: Stroke | null = null;
  private readonly onChange: () => void;

  constructor(view: MaskEditView, onChange: () => void) {
    this.view = view;
    this.onChange = onChange;
    void this.sync();
  }

  get key(): string {
    return `${this.view.kind}:${this.view.target}`;
  }

  update(view: MaskEditView): void {
    this.view = view;
    this.failed = false;
    void this.sync();
  }

  /** Маску поменяли не мазки отсюда: отмена, «Расширить по правке» */
  markStale(): void {
    this.stale = true;
    this.failed = false;
    void this.sync();
  }

  dispose(): void {
    this.disposed = true;
    this.below?.close();
    this.above?.close();
    this.snapshot?.layer.close();
    this.snapshot?.hard.close();
    for (const c of [this.layer, this.hard, this.coverage]) c.width = c.height = 0;
  }

  /** Сколько пикселей превью в пикселе холста */
  private get scale(): number {
    return this.width / this.view.rect.width;
  }

  private async sync(): Promise<void> {
    if (this.loading || this.disposed || this.failed) return;
    const v = this.view;
    const want = {
      below: v.below !== this.loaded.below,
      above: v.above !== this.loaded.above,
      layer: v.layer !== this.loaded.layer,
      mask: !this.mask || (this.stale && this.inflight === 0 && !this.stroke),
    };
    if (!want.below && !want.above && !want.layer && !want.mask) return;
    this.loading = true;
    const strokes = this.strokes;
    const got = await Promise.all([
      want.below ? fetchImage(v.below) : null,
      want.above ? fetchImage(v.above) : null,
      want.layer ? fetchImage(v.layer) : null,
      want.mask ? fetchImage(v.mask) : null,
    ]).catch((err: unknown) => {
      console.warn('Превью маски:', err);
      this.failed = true;
      return null;
    });
    this.loading = false;
    if (!got || this.disposed) {
      for (const g of got ?? []) g?.bitmap.close();
      return;
    }
    const [below, above, layer, mask] = got;
    const size = (below ?? above ?? layer ?? mask)!.bitmap;
    if (size.width !== this.width || size.height !== this.height) this.resize(size.width, size.height);
    if (below) {
      this.below?.close();
      this.below = below.bitmap;
      this.loaded.below = v.below;
    }
    if (above) {
      this.above?.close();
      this.above = above.bitmap;
      this.loaded.above = v.above;
    }
    if (layer) {
      const rgba = this.pixels(layer.bitmap);
      if (this.layerPx) for (let i = 3; i < rgba.data.length; i += 4) rgba.data[i] = this.layerPx.data[i]!;
      this.layerPx = rgba;
      this.layer.getContext('2d')!.putImageData(rgba, 0, 0);
      this.loaded.layer = v.layer;
    }
    let remask = false;
    if (mask) {
      // Пока маска шла, по превью рисовали: она уже не та — берём её, только если своей ещё нет
      const fresh = this.strokes === strokes && this.inflight === 0;
      if (fresh || !this.mask) {
        const px = this.pixels(mask.bitmap).data;
        this.mask = new Uint8Array(this.width * this.height);
        for (let i = 0; i < this.mask.length; i++) this.mask[i] = px[i * 4]!;
        remask = true;
      }
      this.stale = !fresh;
    }
    if (this.layerPx && this.mask && (remask || !this.ready)) this.refresh(null);
    else if (layer) {
      // Другой вариант задачи: маска та же, сменились цвета слоя
      this.version++;
      this.snap();
    }
    this.ready = !!(this.below && this.above && this.layerPx && this.mask);
    this.onChange();
    void this.sync();
  }

  private resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    for (const c of [this.layer, this.hard, this.coverage]) {
      c.width = width;
      c.height = height;
    }
    this.mask = null;
    this.layerPx = null;
    this.loaded.layer = '';
  }

  private pixels(bitmap: ImageBitmap): ImageData {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, this.width, this.height);
    bitmap.close();
    return ctx.getImageData(0, 0, this.width, this.height);
  }

  private coverageCtx(): CanvasRenderingContext2D {
    return this.coverage.getContext('2d', { willReadFrequently: true })!;
  }

  private toPx(p: [number, number]): [number, number] {
    const k = this.scale;
    return [(p[0] - this.view.rect.x) * k, (p[1] - this.view.rect.y) * k];
  }

  // ——— Мазки ———

  /** Мазок кисти начался; false — превью ещё не готово, мазок пойдёт на сервер без показа здесь */
  begin(p: [number, number], size: number, softness: number, erase: boolean): boolean {
    if (!this.ready) return false;
    this.strokes++;
    const k = this.scale;
    const fade = (size / 2) * Math.min(Math.max(softness, 0), 1);
    // Порог жёсткой кисти — как у сервера, в пикселях холста
    const soft = fade >= 0.5;
    const sprite = brushSprite(size * k, fade * k, soft);
    const spacing = Math.max(0.5, Math.min((size * k) / 10, soft ? (fade * k) / 10 : Infinity));
    const last = this.toPx(p);
    this.stroke = { erase, box: null, brush: { sprite, spacing, last } };
    this.refresh(this.dab(last));
    return true;
  }

  extend(p: [number, number]): void {
    const brush = this.stroke?.brush;
    if (!brush) return;
    const { spacing, last } = brush;
    const to = this.toPx(p);
    const dist = Math.hypot(to[0] - last[0], to[1] - last[1]);
    const steps = Math.floor(dist / spacing);
    if (!steps) return;
    const step = [((to[0] - last[0]) / dist) * spacing, ((to[1] - last[1]) / dist) * spacing];
    let box: Rect | null = null;
    for (let i = 1; i <= steps; i++) box = union(box, this.dab([last[0] + step[0]! * i, last[1] + step[1]! * i]));
    brush.last = [last[0] + step[0]! * steps, last[1] + step[1]! * steps];
    if (box) this.refresh(box);
  }

  /** Отпечаток кисти в покрытие; возвращает задетый участок */
  private dab(at: [number, number]): Rect {
    const s = this.stroke!;
    const sprite = s.brush!.sprite;
    const n = sprite.width;
    const ctx = this.coverageCtx();
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(sprite, at[0] - n / 2, at[1] - n / 2);
    const box = { x: Math.floor(at[0] - n / 2) - 1, y: Math.floor(at[1] - n / 2) - 1, width: n + 3, height: n + 3 };
    s.box = union(s.box, box);
    return box;
  }

  /** Мазок закончен: покрытие ложится в маску */
  end(): void {
    const s = this.stroke;
    this.stroke = null;
    if (s?.box) this.commit(s.box, s.erase);
    this.snap();
  }

  private snap(): void {
    if (this.stroke || this.disposed) return;
    const version = this.version;
    void Promise.all([createImageBitmap(this.layer), createImageBitmap(this.hard)]).then(([layer, hard]) => {
      if (this.disposed || version !== this.version) {
        layer.close();
        hard.close();
        return;
      }
      this.snapshot?.layer.close();
      this.snapshot?.hard.close();
      this.snapshot = { layer, hard, version };
      this.onChange();
    });
  }

  private fresh(): { layer: CanvasImageSource; hard: CanvasImageSource } {
    return this.snapshot?.version === this.version ? this.snapshot : { layer: this.layer, hard: this.hard };
  }

  /** Где маска больше половины — для контура */
  get outline(): CanvasImageSource {
    return this.fresh().hard;
  }

  /** Прямоугольник или лассо целиком — на отпускании; false — превью ещё не готово */
  fill(shape: MaskShape): boolean {
    if (!this.ready || shape.kind === 'stroke') return false;
    this.strokes++;
    const k = this.scale;
    const { x: ox, y: oy } = this.view.rect;
    const ctx = this.coverageCtx();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    let pts: [number, number][];
    if (shape.kind === 'rect') {
      pts = [[shape.x, shape.y], [shape.x + shape.width, shape.y + shape.height]];
      ctx.rect((shape.x - ox) * k, (shape.y - oy) * k, shape.width * k, shape.height * k);
    } else if (shape.kind === 'ellipse') {
      pts = [[shape.cx - shape.rx, shape.cy - shape.ry], [shape.cx + shape.rx, shape.cy + shape.ry]];
      ctx.ellipse((shape.cx - ox) * k, (shape.cy - oy) * k, shape.rx * k, shape.ry * k, 0, 0, Math.PI * 2);
    } else {
      pts = shape.points;
      shape.points.forEach(([x, y], i) => (i ? ctx.lineTo((x - ox) * k, (y - oy) * k) : ctx.moveTo((x - ox) * k, (y - oy) * k)));
      ctx.closePath();
    }
    ctx.fill();
    const xs = pts.map((p) => (p[0] - ox) * k);
    const ys = pts.map((p) => (p[1] - oy) * k);
    const box = { x: Math.floor(Math.min(...xs)) - 1, y: Math.floor(Math.min(...ys)) - 1, width: 0, height: 0 };
    box.width = Math.ceil(Math.max(...xs)) + 2 - box.x;
    box.height = Math.ceil(Math.max(...ys)) + 2 - box.y;
    this.stroke = { erase: !!shape.erase, box };
    this.refresh(box);
    this.end();
    return true;
  }

  /** Мазок на сервер; applied — превью его уже показывает, иначе маску после ответа надо перезапросить */
  send(shape: MaskShape, applied: boolean, post: (shape: MaskShape) => Promise<MaskEditResult>): void {
    this.inflight++;
    if (!applied) this.strokes++;
    post(shape)
      .then((res) => {
        this.settleRev = Math.max(this.settleRev, res.rev);
        if (!applied) this.stale = true;
      })
      .catch(() => {
        this.stale = true;
      })
      .finally(() => {
        this.inflight--;
        this.onChange();
        void this.sync();
      });
  }

  /** Клип участка по границам превью */
  private clip(r: Rect): Rect {
    const x = Math.max(0, r.x);
    const y = Math.max(0, r.y);
    return { x, y, width: Math.max(0, Math.min(this.width, r.x + r.width) - x), height: Math.max(0, Math.min(this.height, r.y + r.height) - y) };
  }

  /** Маска участка box с покрытием мазка (erase — стирающего; без него — без мазка): как его наложит сервер (applyShapes) */
  private withStroke(box: Rect, erase = this.stroke?.erase): Uint8Array {
    const out = new Uint8Array(box.width * box.height);
    const mask = this.mask!;
    for (let row = 0; row < box.height; row++) out.set(mask.subarray((box.y + row) * this.width + box.x, (box.y + row) * this.width + box.x + box.width), row * box.width);
    if (erase === undefined || !box.width || !box.height) return out;
    const cov = this.coverageCtx().getImageData(box.x, box.y, box.width, box.height).data;
    const target = erase ? 0 : 255;
    for (let i = 0; i < out.length; i++) {
      const a = (cov[i * 4]! * cov[i * 4 + 3]!) / 255;
      if (a) out[i] = Math.round(out[i]! + ((target - out[i]!) * a) / 255);
    }
    return out;
  }

  /** Покрытие мазка — в маску, само покрытие — стереть */
  private commit(box: Rect, erase: boolean): void {
    const b = this.clip(box);
    const drawn = this.withStroke(b, erase);
    for (let row = 0; row < b.height; row++) this.mask!.set(drawn.subarray(row * b.width, (row + 1) * b.width), (b.y + row) * this.width + b.x);
    this.coverageCtx().clearRect(b.x, b.y, b.width, b.height);
  }

  /**
   * Пересчитать превью около участка changed (пиксели превью; null — всё): маска с текущим мазком →
   * растушёвка → альфа слоя и контур. Растушёвка дотягивается на feather, поэтому участок расширяется на неё дважды.
   */
  private refresh(changed: Rect | null): void {
    if (!this.layerPx || !this.mask) return;
    const f = this.view.feather * this.scale;
    const reach = f > 0 ? Math.ceil(f) + 1 : 0;
    const grow = (r: Rect) => this.clip({ x: r.x - reach, y: r.y - reach, width: r.width + 2 * reach, height: r.height + 2 * reach });
    const area = changed ? grow(changed) : { x: 0, y: 0, width: this.width, height: this.height };
    const box = changed ? grow(area) : area;
    if (!area.width || !area.height) return;
    const mask = this.withStroke(box);
    const alpha = featherAlpha(mask, box.width, box.height, f);
    const px = this.layerPx!.data;
    const hard = new ImageData(area.width, area.height);
    for (let row = 0; row < area.height; row++) {
      for (let col = 0; col < area.width; col++) {
        const b = (area.y - box.y + row) * box.width + area.x - box.x + col;
        px[((area.y + row) * this.width + area.x + col) * 4 + 3] = Math.round(alpha[b]! * 255);
        if (mask[b]! >= MASK_THRESHOLD) hard.data.fill(255, (row * area.width + col) * 4, (row * area.width + col) * 4 + 4);
      }
    }
    this.layer.getContext('2d')!.putImageData(this.layerPx!, 0, 0, area.x, area.y, area.width, area.height);
    this.hard.getContext('2d')!.putImageData(hard, area.x, area.y);
    this.version++;
    this.snap();
    this.onChange();
  }

  /** Участок, каким он станет: холст под слоем, слой по маске, слои над ним. ctx — в координатах холста */
  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.ready) return;
    const { x, y, width, height } = this.view.rect;
    ctx.imageSmoothingQuality = 'medium';
    ctx.drawImage(this.below!, x, y, width, height);
    ctx.drawImage(this.fresh().layer, x, y, width, height);
    ctx.drawImage(this.above!, x, y, width, height);
  }
}

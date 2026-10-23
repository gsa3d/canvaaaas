// Документ: исходная картинка, принятые правки отдельными слоями и итоговый холст.
// Правки недеструктивные: любой участок можно пересобрать из исходника и включённых слоёв,
// поэтому откат правки — это просто её выключение. Для просмотра держим пирамиду уменьшенных
// копий и режем из неё тайлы по запросу.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { applyLayer, type RawImage } from './edit-region.ts';
import { intersect, type Rect } from './frame.ts';
import { encodeImage } from './image-file.ts';

export const TILE_SIZE = 512;
const TILE_CACHE_LIMIT = 600;

export interface Patch {
  id: string;
  /** Где слой лежит на холсте */
  rect: Rect;
  /** RGBA размером с rect: цвет правки и её растушёванная маска в альфе */
  layer: Buffer;
  prompt: string;
  jobId: string;
  variant: number;
  active: boolean;
  createdAt: string;
}

interface Level {
  width: number;
  height: number;
  data: Buffer;
}

type HistoryOp = { kind: 'add'; patch: Patch; index: number } | { kind: 'toggle'; patchId: string };

// Уменьшение вдвое средним по 2×2 для участка уровня dst (на краях нечётных размеров пиксель повторяется)
function downsample(src: Level, dst: Level, rect: Rect): void {
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const sy0 = 2 * y;
    const sy1 = Math.min(sy0 + 1, src.height - 1);
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      const sx0 = 2 * x;
      const sx1 = Math.min(sx0 + 1, src.width - 1);
      const a = (sy0 * src.width + sx0) * 3;
      const b = (sy0 * src.width + sx1) * 3;
      const c = (sy1 * src.width + sx0) * 3;
      const d = (sy1 * src.width + sx1) * 3;
      const o = (y * dst.width + x) * 3;
      for (let k = 0; k < 3; k++) {
        dst.data[o + k] = (src.data[a + k]! + src.data[b + k]! + src.data[c + k]! + src.data[d + k]! + 2) >> 2;
      }
    }
  }
}

export class CanvasDocument {
  readonly id = randomUUID();
  /** Имя файла; меняется после «Сохранить как» */
  name: string;
  readonly width: number;
  readonly height: number;
  /** Исходник, RGB 8 бит; никогда не меняется */
  readonly base: Buffer;
  /** Исходник с включёнными правками, RGB 8 бит */
  readonly composite: Buffer;
  style = '';
  patches: Patch[] = [];
  /** Растёт при каждом изменении холста: по нему браузер понимает, что тайлы устарели */
  rev = 1;
  private readonly levels: Level[];
  private readonly tiles = new Map<string, Buffer>();
  private undoStack: HistoryOp[] = [];
  private redoStack: HistoryOp[] = [];

  private constructor(name: string, width: number, height: number, base: Buffer) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.base = base;
    this.composite = Buffer.from(base);
    this.levels = [{ width, height, data: this.composite }];
    while (true) {
      const prev = this.levels[this.levels.length - 1]!;
      if (Math.max(prev.width, prev.height) <= TILE_SIZE) break;
      const level = { width: Math.ceil(prev.width / 2), height: Math.ceil(prev.height / 2), data: Buffer.alloc(0) };
      level.data = Buffer.alloc(level.width * level.height * 3);
      downsample(prev, level, { x: 0, y: 0, width: level.width, height: level.height });
      this.levels.push(level);
    }
  }

  /** Открыть картинку: прозрачность ложится на белый, всё приводится к sRGB 8 бит */
  static async open(input: string | Buffer, name: string): Promise<CanvasDocument> {
    const { data, info } = await sharp(input, { limitInputPixels: false, autoOrient: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`Неожиданное число каналов: ${info.channels}`);
    return new CanvasDocument(name, info.width, info.height, data);
  }

  static blank(width: number, height: number, color: [number, number, number], name: string): CanvasDocument {
    if (!(width >= 16 && height >= 16 && width <= 30000 && height <= 30000)) {
      throw new Error('Размер холста — от 16 до 30000 пикселей по каждой стороне');
    }
    const base = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) base.set(color, i * 3);
    return new CanvasDocument(name, width, height, base);
  }

  raw(): RawImage {
    return { data: this.composite, width: this.width, height: this.height, channels: 3 };
  }

  /** Копия холста: её можно долго кодировать, пока на холст ложатся новые правки */
  snapshot(): RawImage {
    return { ...this.raw(), data: Buffer.from(this.composite) };
  }

  /** Миниатюра для списка недавних файлов, JPEG не больше max по большей стороне */
  thumbnail(max = 360): Promise<Buffer> {
    const level = this.levels.findLast((l) => Math.max(l.width, l.height) >= max) ?? this.levels[0]!;
    return sharp(level.data, { raw: { width: level.width, height: level.height, channels: 3 } })
      .resize(max, max, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  }

  get levelCount(): number {
    return this.levels.length;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Принять правку: слой ложится поверх текущего холста */
  addPatch(patch: Omit<Patch, 'active'>): Patch {
    const full: Patch = { ...patch, active: true };
    this.patches.push(full);
    applyLayer({ data: this.composite, rect: this.bounds(), channels: 3 }, full.rect, full.layer);
    this.refresh(full.rect);
    this.undoStack.push({ kind: 'add', patch: full, index: this.patches.length - 1 });
    this.redoStack = [];
    return full;
  }

  /** Выключить или снова включить правку из истории */
  togglePatch(patchId: string): void {
    this.flip(patchId);
    this.undoStack.push({ kind: 'toggle', patchId });
    this.redoStack = [];
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    if (op.kind === 'add') {
      this.patches.splice(op.index, 1);
      this.recompute(op.patch.rect);
    } else {
      this.flip(op.patchId);
    }
    this.redoStack.push(op);
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    if (op.kind === 'add') {
      this.patches.splice(op.index, 0, op.patch);
      this.recompute(op.patch.rect);
    } else {
      this.flip(op.patchId);
    }
    this.undoStack.push(op);
  }

  /** Тайл уровня k (0 — полное разрешение), JPEG */
  async tile(k: number, tx: number, ty: number): Promise<Buffer> {
    const level = this.levels[k];
    if (!level) throw new Error(`Нет уровня ${k}`);
    const x = tx * TILE_SIZE;
    const y = ty * TILE_SIZE;
    if (x >= level.width || y >= level.height || tx < 0 || ty < 0) throw new Error('Тайл за пределами холста');
    const key = `${k}/${tx}/${ty}`;
    const cached = this.tiles.get(key);
    if (cached) {
      this.tiles.delete(key);
      this.tiles.set(key, cached);
      return cached;
    }
    const width = Math.min(TILE_SIZE, level.width - x);
    const height = Math.min(TILE_SIZE, level.height - y);
    const buf = Buffer.alloc(width * height * 3);
    for (let row = 0; row < height; row++) {
      const from = ((y + row) * level.width + x) * 3;
      level.data.copy(buf, row * width * 3, from, from + width * 3);
    }
    const jpeg = await sharp(buf, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    this.tiles.set(key, jpeg);
    if (this.tiles.size > TILE_CACHE_LIMIT) this.tiles.delete(this.tiles.keys().next().value!);
    return jpeg;
  }

  /** Плоский PNG в полном разрешении */
  exportPng(): Promise<Buffer> {
    return encodeImage(this.snapshot(), 'png');
  }

  private bounds(): Rect {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  private flip(patchId: string): void {
    const patch = this.patches.find((p) => p.id === patchId);
    if (!patch) throw new Error('Нет такой правки');
    patch.active = !patch.active;
    this.recompute(patch.rect);
  }

  /** Пересобрать участок из исходника и включённых правок по порядку */
  private recompute(rect: Rect): void {
    const region = { data: Buffer.alloc(rect.width * rect.height * 3), rect, channels: 3 };
    for (let row = 0; row < rect.height; row++) {
      const from = ((rect.y + row) * this.width + rect.x) * 3;
      this.base.copy(region.data, row * rect.width * 3, from, from + rect.width * 3);
    }
    for (const p of this.patches) {
      if (p.active && intersect(p.rect, rect).width > 0) applyLayer(region, p.rect, p.layer);
    }
    for (let row = 0; row < rect.height; row++) {
      region.data.copy(this.composite, ((rect.y + row) * this.width + rect.x) * 3, row * rect.width * 3, (row + 1) * rect.width * 3);
    }
    this.refresh(rect);
  }

  /** Обновить уменьшенные копии и выбросить устаревшие тайлы для изменённого участка */
  private refresh(rect: Rect): void {
    let r = rect;
    for (let k = 0; k < this.levels.length; k++) {
      if (k > 0) {
        const level = this.levels[k]!;
        const x0 = Math.floor(r.x / 2);
        const y0 = Math.floor(r.y / 2);
        const x1 = Math.min(level.width, Math.ceil((r.x + r.width) / 2));
        const y1 = Math.min(level.height, Math.ceil((r.y + r.height) / 2));
        r = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
        downsample(this.levels[k - 1]!, level, r);
      }
      for (let ty = Math.floor(r.y / TILE_SIZE); ty * TILE_SIZE < r.y + r.height; ty++) {
        for (let tx = Math.floor(r.x / TILE_SIZE); tx * TILE_SIZE < r.x + r.width; tx++) {
          this.tiles.delete(`${k}/${tx}/${ty}`);
        }
      }
    }
    this.rev++;
  }
}

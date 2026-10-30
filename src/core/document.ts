// Документ: исходная картинка (фон), слои поверх неё и итоговый холст.
// Слой (DocObject, objects) — кусок картинки по маске: имя, части, видимость и версии. Версия (Patch, patches) — пиксели генерации
// с маской; на холсте у слоя видна одна — текущая (current), без неё слой показывает исходник, то есть ничего не меняет.
// Порядок на холсте задают слои: по порядку появления — новый сверху, но часть не ниже того, частью чего она является;
// заплатка фона (слой kind: 'fill') — прямо под слоем, под которым её дорисовали: она закрывает всё, что было под ним;
// слой удалили — заплатка остаётся там, где её дорисовали.
// Всё недеструктивно: любой участок пересобирается из исходника и видимых версий, поэтому смена версии, скрытие слоя и
// правка маски версии — просто пересборка участка. Для просмотра держим пирамиду уменьшенных копий и режем из неё тайлы.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { InputImage } from '../providers/types.ts';
import type { ModelChoice, SizeChoice, SketchStroke } from '../shared/api.ts';
import { applyLayer, type RawImage, type RawRegion } from './edit-region.ts';
import { intersect, type Rect } from './frame.ts';
import { encodeImage } from './image-file.ts';
import { featherAlpha, featherAlphaRegion } from './mask.ts';

export const TILE_SIZE = 512;
const TILE_CACHE_LIMIT = 600;
/** Сколько шагов помнит отмена: шаг правки маски держит маску размером со слой */
const HISTORY_LIMIT = 100;

export interface Patch {
  id: string;
  /** Где слой лежит на холсте */
  rect: Rect;
  /** RGBA размером с rect: цвет ответа модели на весь rect и растушёванная маска в альфе */
  layer: Buffer;
  /** Маска слоя до растушёвки, один канал размером с rect: 0 — слоя не видно */
  mask: Uint8Array;
  /** Растушёвка внутрь маски, пиксели холста */
  feather: number;
  /** Номер состояния маски: входит в contentKey, отмена возвращает прежний */
  maskVersion: number;
  prompt: string;
  jobId: string;
  variant: number;
  active: boolean;
  createdAt: string;
  /** С чем слой генерировали: с тем же его можно перерисовать ещё раз */
  model?: ModelChoice;
  size?: SizeChoice;
  refs?: InputImage[];
  /** Модель не видела, что было под маской: область ей стёрли */
  hide?: boolean;
  /** Задача, как её расписал директор: с ней же идут «Ещё варианты» с той же задачей */
  directed?: string;
  sketch?: SketchStroke[];
  /** Слой, чья это версия. Версия без слоя (так кладут правки тесты) видна по active и лежит под всеми слоями */
  object?: string;
  /**
   * Исходник отделённого слоя (object): пиксели холста под его маской, снятые, когда под ним дорисовали фон.
   * Виден, когда у слоя нет текущей версии; со слоем сдвигается
   */
  lifted?: boolean;
}

/**
 * Слой: имя и маска куска картинки, его части (parent), видимость и текущая версия. Запись не меняется на месте:
 * изменение кладёт новую, поэтому шаг отмены — просто прежний список.
 */
export interface DocObject {
  id: string;
  name: string;
  /** Где маска лежит на холсте */
  rect: Rect;
  /** Один канал 0/255 размером с rect */
  mask: Uint8Array;
  /** Объект, частью которого этот является */
  parent?: string;
  createdAt: string;
  /** Номер состояния маски: растёт, когда маска меняется */
  version: number;
  /** После правки на холсте объект не нашёлся: маска прежняя */
  lost?: boolean;
  /** Слой скрыт — с частями */
  hidden?: boolean;
  /** Текущая версия (id в patches); нет — исходник */
  current?: string;
  /** Заплатка фона под отделённым слоем: лежит прямо на исходнике, под всеми слоями, частей у неё нет */
  kind?: 'fill';
  /** Под каким слоем эта заплатка */
  under?: string;
  /** Слой появился из генерации по выделению: частью другого стать может, а другие его частями — нет */
  edit?: boolean;
}

interface Level {
  width: number;
  height: number;
  data: Buffer;
}

/** Маска без feather и maskVersion выводится из альфы слоя — так принимают правки тесты */
export type NewPatch = Omit<Patch, 'active' | 'mask' | 'feather' | 'maskVersion'> & { mask?: Uint8Array; feather?: number };

interface MaskState {
  mask: Uint8Array;
  version: number;
}

type HistoryOp =
  | { kind: 'add'; patch: Patch; index: number }
  | { kind: 'remove'; patch: Patch; index: number }
  | { kind: 'replace'; before: Patch; after: Patch; index: number }
  | { kind: 'toggle'; patchId: string }
  /** changed — участок маски, где before и after различаются: отмена пересчитывает только его */
  | { kind: 'mask'; patchId: string; before: MaskState; after: MaskState; changed?: Rect }
  | { kind: 'objects'; before: DocObject[]; after: DocObject[] }
  /** Слой сдвинули: размер тот же, другое место */
  | { kind: 'move'; patchId: string; from: Rect; to: Rect }
  /** Несколько шагов, которые отменяются разом: принятая правка и маски объектов, пересчитанные после неё */
  | { kind: 'group'; ops: HistoryOp[] };

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

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

/** Уровни уменьшенных вдвое копий, пока картинка не влезет в один тайл */
function pyramid(data: Buffer, width: number, height: number): Level[] {
  const levels: Level[] = [{ width, height, data }];
  while (true) {
    const prev = levels[levels.length - 1]!;
    if (Math.max(prev.width, prev.height) <= TILE_SIZE) break;
    const level = { width: Math.ceil(prev.width / 2), height: Math.ceil(prev.height / 2), data: Buffer.alloc(0) };
    level.data = Buffer.alloc(level.width * level.height * 3);
    downsample(prev, level, { x: 0, y: 0, width: level.width, height: level.height });
    levels.push(level);
  }
  return levels;
}

/** Положить слой правки (RGBA) поверх прозрачного RGBA-участка dst: так несколько слоёв сводятся в один с той же картинкой поверх холста */
function overLayer(dst: Buffer, rect: Rect, layerRect: Rect, layer: Buffer): void {
  const o = intersect(rect, layerRect);
  for (let y = o.y; y < o.y + o.height; y++) {
    for (let x = o.x; x < o.x + o.width; x++) {
      const l = ((y - layerRect.y) * layerRect.width + x - layerRect.x) * 4;
      const a = layer[l + 3]! / 255;
      if (a === 0) continue;
      const d = ((y - rect.y) * rect.width + x - rect.x) * 4;
      const under = (dst[d + 3]! / 255) * (1 - a);
      const out = a + under;
      for (let c = 0; c < 3; c++) dst[d + c] = Math.round((layer[l + c]! * a + dst[d + c]! * under) / out);
      dst[d + 3] = Math.round(out * 255);
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
  objects: DocObject[] = [];
  /** Растёт при каждом изменении холста: по нему браузер понимает, что тайлы устарели */
  rev = 1;
  private readonly levels: Level[];
  private readonly tiles = new Map<string, Buffer>();
  /** Пирамида исходника — для сравнения «до»; строится при первом запросе */
  private baseLevels: Level[] | null = null;
  private undoStack: HistoryOp[] = [];
  private redoStack: HistoryOp[] = [];
  private maskVersions = 0;
  private objectVersions = 0;
  /** Шаги внутри batch: лягут одним */
  private collecting: HistoryOp[] | null = null;

  private constructor(name: string, width: number, height: number, base: Buffer, patches: Patch[] = [], objects: DocObject[] = []) {
    this.name = name;
    this.width = width;
    this.height = height;
    this.base = base;
    this.composite = Buffer.from(base);
    this.patches = patches;
    this.objects = objects;
    this.sync();
    for (const p of this.drawOrder()) applyLayer({ data: this.composite, rect: this.bounds(), channels: 3 }, p.rect, p.layer);
    this.levels = pyramid(this.composite, width, height);
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

  /** Документ из проекта .caaa: исходник, слои с масками и объекты как были, история отмены начинается заново */
  static restore(name: string, width: number, height: number, base: Buffer, patches: Patch[], objects: DocObject[] = []): CanvasDocument {
    if (base.length !== width * height * 3) throw new Error('Исходник не того размера');
    return new CanvasDocument(name, width, height, base, patches, objects);
  }

  raw(): RawImage {
    return { data: this.composite, width: this.width, height: this.height, channels: 3 };
  }

  /** Участок холста, RGB размером с rect (копия) */
  region(rect: Rect): Buffer {
    const out = Buffer.alloc(rect.width * rect.height * 3);
    for (let row = 0; row < rect.height; row++) {
      const from = ((rect.y + row) * this.width + rect.x) * 3;
      this.composite.copy(out, row * rect.width * 3, from, from + rect.width * 3);
    }
    return out;
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

  /** Холст однозначно задан исходником и видимыми версиями с их масками по порядку: одинаковый ключ — одинаковые пиксели */
  get contentKey(): string {
    return this.drawOrder()
      .map((p) => `${p.id}:${p.maskVersion}@${p.rect.x},${p.rect.y}`)
      .join(',');
  }

  /** То же со скрытыми слоями — они тоже ложатся в проект .caaa */
  get layersKey(): string {
    return this.patches.map((p) => `${p.id}:${p.maskVersion}@${p.rect.x},${p.rect.y}${p.active ? '' : ':off'}`).join(',');
  }

  /** Объекты с именами, частями и масками: меняется — проекту .caaa есть что сохранить */
  get objectsKey(): string {
    return this.objects.map((o) => `${o.id}:${o.version}:${o.parent ?? ''}:${o.lost ? 1 : 0}:${o.hidden ? 1 : 0}:${o.current ?? ''}:${o.name}`).join('\n');
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Новая версия слоя (или правка без слоя — поверх других таких); видна ли она, решает её слой */
  addPatch(patch: NewPatch): Patch {
    const full = this.complete(patch);
    this.patches.push(full);
    this.sync();
    if (full.active) this.recompute(this.clip(full.rect));
    this.record({ kind: 'add', patch: full, index: this.patches.length - 1 });
    return full;
  }

  /** Удалить версию; ⌘Z возвращает её */
  removePatch(patchId: string): void {
    const index = this.indexOf(patchId);
    const [patch] = this.patches.splice(index, 1);
    this.sync();
    this.recompute(this.clip(patch!.rect));
    this.record({ kind: 'remove', patch: patch!, index });
  }

  /** Новый вариант слоя на его место в стопке: слои над ним остаются сверху; ⌘Z возвращает прежний */
  replacePatch(patchId: string, patch: NewPatch): Patch {
    const index = this.indexOf(patchId);
    const before = this.patches[index]!;
    const after = this.complete(patch);
    this.patches[index] = after;
    this.sync();
    this.recompute(this.clip(union(before.rect, after.rect)));
    this.record({ kind: 'replace', before, after, index });
    return after;
  }

  /** Сдвинуть слой на место to того же размера, целиком на холсте; ⌘Z возвращает прежнее */
  movePatch(patchId: string, to: Rect): void {
    const patch = this.patch(patchId);
    const from = patch.rect;
    if (to.width !== from.width || to.height !== from.height) throw new Error('Сдвиг не меняет размер слоя');
    if (to.x < 0 || to.y < 0 || to.x + to.width > this.width || to.y + to.height > this.height) throw new Error('Слой за краем холста');
    if (to.x === from.x && to.y === from.y) return;
    this.place(patch, to, from);
    this.record({ kind: 'move', patchId, from, to });
  }

  /** Выключить или снова включить правку из истории */
  togglePatch(patchId: string): void {
    this.flip(patchId);
    this.record({ kind: 'toggle', patchId });
  }

  patch(patchId: string): Patch {
    return this.patches[this.indexOf(patchId)]!;
  }

  hasPatch(patchId: string): boolean {
    return this.patches.some((p) => p.id === patchId);
  }

  /** Участок холста без слоя patchId — каким он был бы, если слой удалить; RGB размером с rect */
  regionWithout(rect: Rect, patchId: string): Buffer {
    return this.compose(rect, patchId).data;
  }

  /** Участок холста, где вместо слоя patchId лежит другой (включённым, на том же месте в стопке): так выглядела бы замена */
  regionReplaced(rect: Rect, patchId: string, layerRect: Rect, layer: Buffer): Buffer {
    return this.compose(rect, patchId, { rect: layerRect, layer }).data;
  }

  /**
   * Участок холста под слоем patchId (исходник и включённые слои ниже, RGB) и над ним (включённые слои выше, RGBA,
   * прозрачно, где их нет) — чтобы браузер показывал правку маски сразу. Без слоя — весь холст под новым слоем сверху.
   */
  regionAround(rect: Rect, patchId: string | null): { below: Buffer; above: Buffer } {
    const order = this.drawOrder();
    const found = patchId === null ? -1 : order.findIndex((p) => p.id === patchId);
    const index = found < 0 ? order.length : found;
    const below = this.compose(rect, undefined, undefined, index).data;
    const above = Buffer.alloc(rect.width * rect.height * 4);
    for (const p of order.slice(index + 1)) {
      if (intersect(p.rect, rect).width > 0) overLayer(above, rect, p.rect, p.layer);
    }
    return { below, above };
  }

  /**
   * Новая маска слоя (до растушёвки) размером с его rect: где 0, сквозь слой виден холст под ним.
   * changed — участок, вне которого маска не менялась: тогда растушёвка и холст пересчитываются только около него.
   */
  setPatchMask(patchId: string, mask: Uint8Array, changed?: Rect): void {
    const patch = this.patch(patchId);
    if (mask.length !== patch.rect.width * patch.rect.height) throw new Error('Маска не того размера');
    const before = { mask: patch.mask, version: patch.maskVersion };
    const after = { mask, version: ++this.maskVersions };
    this.applyMask(patch, after, changed);
    this.record({ kind: 'mask', patchId, before, after, changed });
  }

  /**
   * Новый список объектов — шаг отмены. join — шаг, к которому его присоединить (historyTop() после правки):
   * если он всё ещё последний, отмена уберёт оба разом; если после него было что-то ещё — обычный отдельный шаг.
   */
  setObjects(next: DocObject[], opts: { join?: unknown } = {}): void {
    const op: HistoryOp = { kind: 'objects', before: this.objects, after: next };
    this.placeObjects(next);
    const top = this.undoStack.at(-1);
    if (opts.join && top === opts.join) {
      this.undoStack[this.undoStack.length - 1] = { kind: 'group', ops: [top, op] };
      this.redoStack = [];
    } else {
      this.record(op);
    }
  }

  /** Номер для новой маски объекта */
  nextObjectVersion(): number {
    return ++this.objectVersions;
  }

  object(objectId: string): DocObject {
    const o = this.objects.find((x) => x.id === objectId);
    if (!o) throw new Error('Нет такого объекта');
    return o;
  }

  /** Всё, что fn меняет в документе, — одним шагом отмены */
  batch<T>(fn: () => T): T {
    if (this.collecting) return fn();
    const ops: HistoryOp[] = [];
    this.collecting = ops;
    try {
      return fn();
    } finally {
      this.collecting = null;
      if (ops.length) this.record(ops.length === 1 ? ops[0]! : { kind: 'group', ops });
    }
  }

  /** Последний шаг истории — чтобы потом присоединить к нему пересчёт масок объектов */
  historyTop(): unknown {
    return this.undoStack.at(-1);
  }

  undo(): void {
    const op = this.undoStack.pop();
    if (!op) return;
    this.revert(op);
    this.redoStack.push(op);
  }

  redo(): void {
    const op = this.redoStack.pop();
    if (!op) return;
    this.apply(op);
    this.undoStack.push(op);
  }

  private revert(op: HistoryOp): void {
    if (op.kind === 'group') {
      for (const o of [...op.ops].reverse()) this.revert(o);
    } else if (op.kind === 'objects') {
      this.placeObjects(op.before);
    } else if (op.kind === 'add') {
      this.patches.splice(op.index, 1);
      this.sync();
      this.recompute(this.clip(op.patch.rect));
    } else if (op.kind === 'remove') {
      this.patches.splice(op.index, 0, op.patch);
      this.sync();
      this.recompute(this.clip(op.patch.rect));
    } else if (op.kind === 'replace') {
      this.patches[op.index] = op.before;
      this.sync();
      this.recompute(this.clip(union(op.before.rect, op.after.rect)));
    } else if (op.kind === 'mask') {
      this.applyMask(this.patch(op.patchId), op.before, op.changed);
    } else if (op.kind === 'move') {
      this.place(this.patch(op.patchId), op.from, op.to);
    } else {
      this.flip(op.patchId);
    }
  }

  private apply(op: HistoryOp): void {
    if (op.kind === 'group') {
      for (const o of op.ops) this.apply(o);
    } else if (op.kind === 'objects') {
      this.placeObjects(op.after);
    } else if (op.kind === 'add') {
      this.patches.splice(op.index, 0, op.patch);
      this.sync();
      this.recompute(this.clip(op.patch.rect));
    } else if (op.kind === 'remove') {
      this.patches.splice(op.index, 1);
      this.sync();
      this.recompute(this.clip(op.patch.rect));
    } else if (op.kind === 'replace') {
      this.patches[op.index] = op.after;
      this.sync();
      this.recompute(this.clip(union(op.before.rect, op.after.rect)));
    } else if (op.kind === 'mask') {
      this.applyMask(this.patch(op.patchId), op.after, op.changed);
    } else if (op.kind === 'move') {
      this.place(this.patch(op.patchId), op.to, op.from);
    } else {
      this.flip(op.patchId);
    }
  }

  private record(op: HistoryOp): void {
    if (this.collecting) {
      this.collecting.push(op);
      return;
    }
    this.undoStack.push(op);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Тайл уровня k (0 — полное разрешение), JPEG */
  tile(k: number, tx: number, ty: number): Promise<Buffer> {
    return this.cut(this.levels, '', k, tx, ty);
  }

  /** Тайл исходника — его показывают, пока держат «\» */
  baseTile(k: number, tx: number, ty: number): Promise<Buffer> {
    this.baseLevels ??= pyramid(this.base, this.width, this.height);
    return this.cut(this.baseLevels, 'base:', k, tx, ty);
  }

  private async cut(levels: Level[], prefix: string, k: number, tx: number, ty: number): Promise<Buffer> {
    const level = levels[k];
    if (!level) throw new Error(`Нет уровня ${k}`);
    const x = tx * TILE_SIZE;
    const y = ty * TILE_SIZE;
    if (x >= level.width || y >= level.height || tx < 0 || ty < 0) throw new Error('Тайл за пределами холста');
    const key = `${prefix}${k}/${tx}/${ty}`;
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

  private indexOf(patchId: string): number {
    const index = this.patches.findIndex((p) => p.id === patchId);
    if (index < 0) throw new Error('Нет такого слоя');
    return index;
  }

  /** Слой из принятой правки: включён, маска ещё не правилась */
  private complete(patch: NewPatch): Patch {
    const { width, height } = patch.rect;
    let mask = patch.mask;
    if (!mask) {
      mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) mask[i] = patch.layer[i * 4 + 3]!;
    }
    return { ...patch, mask, feather: patch.mask ? (patch.feather ?? 0) : 0, maskVersion: 0, active: true };
  }

  /** Слой на месте to вместо from: холст пересобирается на обоих */
  private place(patch: Patch, to: Rect, from: Rect): void {
    patch.rect = to;
    if (patch.active) this.recompute(this.clip(union(from, to)));
  }

  /** Скрыть или показать правку без слоя; у версии слоя видимость решает слой */
  private flip(patchId: string): void {
    const patch = this.patch(patchId);
    if (patch.object) throw new Error('Версию слоя показывает её слой');
    patch.active = !patch.active;
    this.recompute(this.clip(patch.rect));
  }

  /** Поставить маску слою: альфа слоя пересчитывается с растушёвкой, участок пересобирается; changed — где маска менялась */
  private applyMask(patch: Patch, state: MaskState, changed?: Rect): void {
    const { width, height } = patch.rect;
    const { rect, alpha } = changed
      ? featherAlphaRegion(state.mask, width, height, patch.feather, changed)
      : { rect: { x: 0, y: 0, width, height }, alpha: featherAlpha(state.mask, width, height, patch.feather) };
    for (let row = 0; row < rect.height; row++) {
      for (let col = 0; col < rect.width; col++) {
        patch.layer[((rect.y + row) * width + rect.x + col) * 4 + 3] = Math.round(alpha[row * rect.width + col]! * 255);
      }
    }
    patch.mask = state.mask;
    patch.maskVersion = state.version;
    if (patch.active) this.recompute({ ...rect, x: patch.rect.x + rect.x, y: patch.rect.y + rect.y });
  }

  /**
   * Что видно на холсте снизу вверх: правки без слоя, затем слои (stack); у слоя — текущая версия
   * или, у отделённого без неё, снятый исходник
   */
  drawOrder(): Patch[] {
    const loose = this.patches.filter((p) => !p.object && p.active);
    const byLayer = new Map<string, Patch>();
    for (const p of this.patches) if (p.object && p.active) byLayer.set(p.object, p);
    return [...loose, ...this.stack().flatMap((o) => byLayer.get(o.id) ?? [])];
  }

  /**
   * Слои снизу вверх: по порядку появления, новый — сверху всех. Часть, появившаяся раньше того, частью чего стала
   * (объединили ⌘J), встаёт сразу над ним: часть не прячется под целым. Заплатка фона — прямо под своим слоем,
   * а без него — там, где появилась
   */
  private stack(): DocObject[] {
    const index = new Map(this.objects.map((o, i) => [o.id, i]));
    const byId = new Map(this.objects.map((o) => [o.id, o]));
    const rank = new Map<string, number>();
    const rankOf = (o: DocObject, depth = 0): number => {
      const known = rank.get(o.id);
      if (known !== undefined) return known;
      const own = index.get(o.id)!;
      let r = own;
      if (depth < 64 && o.kind === 'fill') {
        const under = o.under ? byId.get(o.under) : undefined;
        if (under && under.kind !== 'fill') r = rankOf(under, depth + 1) - 0.25;
      } else if (depth < 64) {
        const parent = o.parent ? byId.get(o.parent) : undefined;
        if (parent && parent.kind !== 'fill') r = Math.max(own, rankOf(parent, depth + 1) + 0.5);
      }
      rank.set(o.id, r);
      return r;
    };
    return [...this.objects].sort((a, b) => rankOf(a) - rankOf(b) || index.get(a.id)! - index.get(b.id)!);
  }

  /**
   * Какие версии видны, — по слоям: у видимого слоя (и всех, частью которых он является) — текущая версия, а без неё —
   * снятый исходник отделённого. У правок без слоя — своё active
   */
  private sync(): void {
    const byId = new Map(this.objects.map((o) => [o.id, o]));
    const visible = (o: DocObject | undefined): boolean => {
      for (let i = 0; o && i < 64; i++) {
        if (o.hidden) return false;
        o = o.parent ? byId.get(o.parent) : undefined;
      }
      return true;
    };
    for (const p of this.patches) {
      if (!p.object) continue;
      const o = byId.get(p.object);
      p.active = !!o && visible(o) && (o.current ? o.current === p.id : !!p.lifted);
    }
  }

  /** Новый список слоев: участки, где видимые версии или их порядок поменялись, пересобираются */
  private placeObjects(next: DocObject[]): void {
    const before = this.drawOrder();
    this.objects = next;
    this.sync();
    const after = this.drawOrder();
    const was = new Set(before);
    const now = new Set(after);
    const changed = [...before.filter((p) => !now.has(p)), ...after.filter((p) => !was.has(p))];
    // Порядок тех же версий поменялся (слой стал частью другого) — пересобрать их все
    const kept = before.filter((p) => now.has(p));
    const common = after.filter((p) => was.has(p));
    if (common.some((p, i) => p !== kept[i])) changed.push(...common);
    for (const p of new Set(changed)) this.recompute(this.clip(p.rect));
  }

  /** Участок, обрезанный по холсту */
  private clip(rect: Rect): Rect {
    return intersect(rect, this.bounds());
  }

  /** Участок из исходника и видимых версий по порядку (первые until); версия skip пропускается, а на её место ложится swap */
  private compose(rect: Rect, skip?: string, swap?: { rect: Rect; layer: Buffer }, until?: number): RawRegion {
    const region = { data: Buffer.alloc(rect.width * rect.height * 3), rect, channels: 3 };
    for (let row = 0; row < rect.height; row++) {
      const from = ((rect.y + row) * this.width + rect.x) * 3;
      this.base.copy(region.data, row * rect.width * 3, from, from + rect.width * 3);
    }
    const order: { id: string; rect: Rect; layer: Buffer }[] = this.drawOrder();
    // Заменяемая версия может быть и не видна сейчас — тогда замена ложится туда, где лежит текущая версия её слоя
    if (skip && swap && !order.some((p) => p.id === skip)) {
      const owner = this.patches.find((p) => p.id === skip)?.object;
      const at = owner ? order.findIndex((p) => this.patches.find((q) => q.id === p.id)?.object === owner) : -1;
      if (at < 0) order.push({ id: skip, ...swap });
      else order.splice(at, 1, { id: skip, ...swap });
    }
    for (const p of order.slice(0, until ?? order.length)) {
      const layer = p.id === skip ? swap : p;
      if (layer && intersect(layer.rect, rect).width > 0) applyLayer(region, layer.rect, layer.layer);
    }
    return region;
  }

  /** Пересобрать участок из исходника и включённых правок по порядку */
  private recompute(rect: Rect): void {
    const region = this.compose(rect);
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

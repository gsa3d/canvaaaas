import { L } from '../shared/i18n.ts';
// Рамка куска, который уходит в модель: выделение + контекстный запас,
// растянутые до ближайших поддерживаемых пропорций модели, и разрешение ответа, которого куску хватает.
// Без Node: тот же расчёт делает интерфейс, чтобы подсказать про разрешение ещё до генерации.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Size = Pick<Rect, 'width' | 'height'>;

/** Запас контекста вокруг выделения: доля от большей стороны и минимум в пикселях */
export const FRAME_CONTEXT = { context: 0.3, contextMin: 128 };
/** Насколько кусок может быть больше ответа модели, прежде чем предупреждать о потере детализации */
export const SCALE_WARN = 1.15;
/** Потолок для auto: 4K у Nano Banana идёт 4–5 минут, его надо просить явно */
export const AUTO_SIZE_CAP = '2K';

/** Какие ответы умеет модель — ImageProvider подходит как есть */
export interface ModelOutputs {
  readonly aspectRatios: readonly string[];
  /** Разрешения от меньшего к большему */
  readonly imageSizes: readonly string[];
  outputSize(aspectRatio: string, imageSize: string): Size;
}

export interface FrameOptions {
  /** Запас контекста с каждой стороны — доля от большей стороны выделения */
  context: number;
  /** Минимальный запас контекста в пикселях */
  contextMin: number;
  aspectRatios: readonly string[];
}

export interface Frame {
  /** Рамка в координатах холста; может выходить за холст, если иначе не влезают пропорции */
  rect: Rect;
  /** Часть рамки внутри холста */
  inside: Rect;
  aspectRatio: string;
}

export function parseRatio(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number);
  if (!w || !h) throw new Error(L(`Непонятные пропорции: ${ratio}`, `Unknown aspect ratio: ${ratio}`));
  return w / h;
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

// Отрезок длины size вокруг центра center внутри [0, total); если не влезает — по центру холста
function place(center: number, size: number, total: number): number {
  if (size >= total) return Math.round((total - size) / 2);
  return Math.min(Math.max(Math.round(center - size / 2), 0), total - size);
}

export function computeFrame(bbox: Rect, canvas: Size, opts: FrameOptions): Frame {
  const canvasRect = { x: 0, y: 0, width: canvas.width, height: canvas.height };
  const margin = Math.max(opts.contextMin, Math.round(opts.context * Math.max(bbox.width, bbox.height)));
  // Контекст за пределами холста не существует, поэтому запас обрезаем по холсту
  const wanted = intersect(
    { x: bbox.x - margin, y: bbox.y - margin, width: bbox.width + 2 * margin, height: bbox.height + 2 * margin },
    canvasRect,
  );
  const cx = wanted.x + wanted.width / 2;
  const cy = wanted.y + wanted.height / 2;

  let best: (Frame & { cost: number }) | undefined;
  for (const aspectRatio of opts.aspectRatios) {
    const r = parseRatio(aspectRatio);
    const width = wanted.width / wanted.height < r ? Math.round(wanted.height * r) : wanted.width;
    const height = wanted.width / wanted.height < r ? wanted.height : Math.round(wanted.width / r);
    const rect = { x: place(cx, width, canvas.width), y: place(cy, height, canvas.height), width, height };
    const inside = intersect(rect, canvasRect);
    // Поля за холстом заполняются отражением и модели почти бесполезны — штрафуем их сильнее
    const padded = width * height - inside.width * inside.height;
    const cost = width * height + 4 * padded;
    if (!best || cost < best.cost) best = { rect, inside, aspectRatio, cost };
  }
  if (!best) throw new Error(L('У модели нет ни одной пропорции', 'The model has no aspect ratios'));
  const { cost: _cost, ...frame } = best;
  return frame;
}

/** Наименьшее разрешение из sizes, при котором ответ модели не меньше куска (с допуском 5%); если не хватает ни одного — наибольшее */
export function fittingSize(model: ModelOutputs, aspectRatio: string, frame: Size, sizes: readonly string[] = model.imageSizes): string {
  for (const size of sizes) {
    const out = model.outputSize(aspectRatio, size);
    if (out.width >= frame.width * 0.95 && out.height >= frame.height * 0.95) return size;
  }
  return sizes[sizes.length - 1]!;
}

/** Разрешение ответа: заданное или для auto — наименьшее подходящее, но не больше maxAuto */
export function chooseImageSize(model: ModelOutputs, aspectRatio: string, frame: Size, requested: string, maxAuto = AUTO_SIZE_CAP): string {
  if (requested !== 'auto') {
    if (!model.imageSizes.includes(requested)) {
      throw new Error(L(`Разрешение ${requested} не поддерживается, есть: ${model.imageSizes.join(', ')}`, `Resolution ${requested} is not supported; available: ${model.imageSizes.join(', ')}`));
    }
    return requested;
  }
  const cap = model.imageSizes.indexOf(maxAuto);
  return fittingSize(model, aspectRatio, frame, cap >= 0 ? model.imageSizes.slice(0, cap + 1) : model.imageSizes);
}

/** Во сколько раз кусок больше ответа модели: больше 1 — детализация падает */
export function frameScale(frame: Size, output: Size): number {
  return Math.max(frame.width / output.width, frame.height / output.height);
}

export interface SizeAdvice {
  frame: Frame;
  /** Разрешение, которое уйдёт модели (для auto — выбранное) */
  imageSize: string;
  output: Size;
  scale: number;
  /** Наименьшее разрешение, которого куску хватает; если не хватает никакого — наибольшее */
  enough: string;
  /** Ответ модели заметно меньше куска: детализация упадёт */
  tooSmall: boolean;
  /** Даже наибольшего разрешения не хватает */
  beyond: boolean;
  /** Куску хватило бы меньшего разрешения */
  tooBig: boolean;
}

/** Хватает ли куску разрешения: тот же расчёт, что в prepareEdit, — для подсказки до генерации */
export function adviseSize(bbox: Rect, canvas: Size, model: ModelOutputs, requested: string, maxAuto = AUTO_SIZE_CAP): SizeAdvice {
  const frame = computeFrame(bbox, canvas, { ...FRAME_CONTEXT, aspectRatios: model.aspectRatios });
  const imageSize = chooseImageSize(model, frame.aspectRatio, frame.rect, requested, maxAuto);
  const output = model.outputSize(frame.aspectRatio, imageSize);
  const scale = frameScale(frame.rect, output);
  const enough = fittingSize(model, frame.aspectRatio, frame.rect);
  return {
    frame,
    imageSize,
    output,
    scale,
    enough,
    tooSmall: scale > SCALE_WARN,
    beyond: frameScale(frame.rect, model.outputSize(frame.aspectRatio, model.imageSizes[model.imageSizes.length - 1]!)) > SCALE_WARN,
    tooBig: model.imageSizes.indexOf(imageSize) > model.imageSizes.indexOf(enough),
  };
}

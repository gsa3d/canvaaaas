// Рамка куска, который уходит в модель: выделение + контекстный запас,
// растянутые до ближайших поддерживаемых пропорций модели.
import type { Size } from '../providers/types.ts';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  if (!w || !h) throw new Error(`Непонятные пропорции: ${ratio}`);
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
  if (!best) throw new Error('У модели нет ни одной пропорции');
  const { cost: _cost, ...frame } = best;
  return frame;
}

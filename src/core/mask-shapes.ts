// Маска из векторных фигур в координатах холста: прямоугольник, эллипс, лассо, мазки кисти и ластика (жёсткой или мягкой).
// Так её будет присылать интерфейс; растеризуется здесь, в полном разрешении, через SVG.
import sharp from 'sharp';
import { shapesBBox, type MaskShape } from '../shared/api.ts';
import type { Rect } from './frame.ts';

export type { MaskShape };

function shapeSvg(shape: MaskShape, i: number): string {
  const fill = shape.erase ? 'black' : 'white';
  switch (shape.kind) {
    case 'rect':
      return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${fill}"/>`;
    case 'ellipse':
      return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" fill="${fill}"/>`;
    case 'polygon':
      return `<polygon points="${shape.points.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`;
    case 'stroke':
      return strokeSvg(shape, fill, i);
  }
}

/**
 * Мазок кисти. У мягкой кисти край размыт по Гауссу: линия уже на половину зоны затухания,
 * σ — пятая часть этой зоны, поэтому к краю кисти мазок сходит почти на нет, а середина остаётся сплошной.
 */
function strokeSvg(shape: Extract<MaskShape, { kind: 'stroke' }>, fill: string, i: number): string {
  const points = shape.points.map((p) => p.join(',')).join(' ');
  const r = shape.size / 2;
  const fade = r * Math.min(Math.max(shape.softness ?? 0, 0), 1);
  const line = (width: number, extra = '') =>
    `<polyline points="${points}" fill="none" stroke="${fill}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
  if (fade < 0.5) return line(shape.size);
  // Область фильтра — в координатах холста: по умолчанию её считают от рамки линии без толщины, и мазок-точку она обрезала бы
  const xs = shape.points.map((p) => p[0]);
  const ys = shape.points.map((p) => p[1]);
  const x = Math.min(...xs) - r - fade;
  const y = Math.min(...ys) - r - fade;
  const box = `x="${x}" y="${y}" width="${Math.max(...xs) + r + fade - x}" height="${Math.max(...ys) + r + fade - y}"`;
  return (
    `<filter id="soft${i}" filterUnits="userSpaceOnUse" ${box} color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${fade / 5}"/></filter>` +
    line(shape.size - fade, ` filter="url(#soft${i})"`)
  );
}

/** Прямоугольник, который задевают фигуры, вместе со стирающими и мягким краем мазков; null — пустой список */
function shapesBounds(shapes: MaskShape[]): { x0: number; y0: number; x1: number; y1: number } | null {
  const box = shapesBBox(shapes.map((s) => ({ ...s, erase: undefined })));
  if (!box) return null;
  // Размытый край мягкого мазка выходит за половину кисти совсем чуть-чуть: с запасом
  const pad = 2 + Math.max(0, ...shapes.map((s) => (s.kind === 'stroke' ? (s.size / 2) * (s.softness ?? 0) : 0)));
  return { x0: box.x - pad, y0: box.y - pad, x1: box.x + box.width + pad, y1: box.y + box.height + pad };
}

/** PNG-маска размером с холст: белое — перерисовать, чёрное — не трогать */
export async function renderMask(width: number, height: number, shapes: MaskShape[]): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="black"/>${shapes.map((shape, i) => shapeSvg(shape, i)).join('')}</svg>`;
  return sharp(Buffer.from(svg), { limitInputPixels: false }).greyscale().png().toBuffer();
}

/**
 * Наложить фигуры на уже готовую маску участка rect: белые фигуры добавляют, ластик стирает.
 * Координаты фигур — холста; всё, что за пределами rect, отсекается.
 */
export async function applyShapes(
  mask: Uint8Array,
  rect: { x: number; y: number; width: number; height: number },
  shapes: MaskShape[],
): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><g transform="translate(${-rect.x} ${-rect.y})">${shapes.map((shape, i) => shapeSvg(shape, i)).join('')}</g></svg>`;
  const layer = await sharp(Buffer.from(svg), { limitInputPixels: false }).ensureAlpha().raw().toBuffer();
  const out = new Uint8Array(mask);
  for (let i = 0; i < out.length; i++) {
    const a = layer[i * 4 + 3]!;
    if (a === 0) continue;
    const v = layer[i * 4]!;
    out[i] = Math.round(out[i]! + ((v - out[i]!) * a) / 255);
  }
  return out;
}

/**
 * То же, что applyShapes, но растеризуется только участок, который задевают фигуры: мазок по большому слою
 * не рисует SVG размером со слой. changed — этот участок в координатах маски; null — фигуры мимо, маска та же.
 */
export async function applyShapesRegion(
  mask: Uint8Array,
  rect: { x: number; y: number; width: number; height: number },
  shapes: MaskShape[],
): Promise<{ mask: Uint8Array; changed: Rect | null }> {
  const b = shapesBounds(shapes);
  const x0 = Math.max(0, Math.floor((b?.x0 ?? 0) - rect.x));
  const y0 = Math.max(0, Math.floor((b?.y0 ?? 0) - rect.y));
  const x1 = Math.min(rect.width, Math.ceil((b?.x1 ?? 0) - rect.x));
  const y1 = Math.min(rect.height, Math.ceil((b?.y1 ?? 0) - rect.y));
  if (!b || x1 <= x0 || y1 <= y0) return { mask, changed: null };
  const changed = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  const part = new Uint8Array(changed.width * changed.height);
  for (let row = 0; row < changed.height; row++) {
    const from = (y0 + row) * rect.width + x0;
    part.set(mask.subarray(from, from + changed.width), row * changed.width);
  }
  const drawn = await applyShapes(part, { ...changed, x: rect.x + x0, y: rect.y + y0 }, shapes);
  const out = new Uint8Array(mask);
  for (let row = 0; row < changed.height; row++) out.set(drawn.subarray(row * changed.width, (row + 1) * changed.width), (y0 + row) * rect.width + x0);
  return { mask: out, changed };
}

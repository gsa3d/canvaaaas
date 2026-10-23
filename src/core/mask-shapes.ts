// Маска из векторных фигур в координатах холста: прямоугольник, эллипс, лассо, мазки кисти и ластика (жёсткой или мягкой).
// Так её будет присылать интерфейс; растеризуется здесь, в полном разрешении, через SVG.
import sharp from 'sharp';
import type { MaskShape } from '../shared/api.ts';

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

// Маска из векторных фигур в координатах холста: прямоугольник, эллипс, лассо, мазки кисти и ластика.
// Так её будет присылать интерфейс; растеризуется здесь, в полном разрешении, через SVG.
import sharp from 'sharp';
import type { MaskShape } from '../shared/api.ts';

export type { MaskShape };

function shapeSvg(shape: MaskShape): string {
  const fill = shape.erase ? 'black' : 'white';
  switch (shape.kind) {
    case 'rect':
      return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${fill}"/>`;
    case 'ellipse':
      return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" fill="${fill}"/>`;
    case 'polygon':
      return `<polygon points="${shape.points.map((p) => p.join(',')).join(' ')}" fill="${fill}"/>`;
    case 'stroke':
      return `<polyline points="${shape.points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${fill}" stroke-width="${shape.size}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
}

/** PNG-маска размером с холст: белое — перерисовать, чёрное — не трогать */
export async function renderMask(width: number, height: number, shapes: MaskShape[]): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="black"/>${shapes.map(shapeSvg).join('')}</svg>`;
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}"><g transform="translate(${-rect.x} ${-rect.y})">${shapes.map(shapeSvg).join('')}</g></svg>`;
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

// Маска из векторных фигур в координатах холста: прямоугольник, эллипс, лассо, мазки кисти и ластика.
// Так её будет присылать интерфейс; растеризуется здесь, в полном разрешении, через SVG.
import sharp from 'sharp';

export type MaskShape =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; erase?: boolean }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; erase?: boolean }
  | { kind: 'polygon'; points: [number, number][]; erase?: boolean }
  | { kind: 'stroke'; points: [number, number][]; size: number; erase?: boolean };

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

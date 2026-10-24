// Набросок для модели: цветные штрихи поверх куска показывают, где и каким должно быть то, что описано в задаче.
// Штрихи хранятся в координатах холста и растеризуются через SVG сразу в размере картинки для модели.
// Ластик стирает только набросок: всё, нарисованное до него, уходит в группу с маской, где его штрих чёрный.
import sharp from 'sharp';
import { shapesBBox, type SketchStroke } from '../shared/api.ts';
import { intersect, type Rect } from './frame.ts';

const COLOR = /^#[0-9a-f]{6}$/i;
const MAX_STROKES = 500;
const MAX_POINTS = 20_000;

/** Набросок из запроса: что не похоже на штрих, — ошибка */
export function checkSketch(value: unknown): SketchStroke[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_STROKES) throw new Error('Набросок не похож на набросок');
  return value.map((s: Partial<SketchStroke>) => {
    const ok =
      Array.isArray(s.points) &&
      s.points.length > 0 &&
      s.points.length <= MAX_POINTS &&
      s.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)) &&
      typeof s.size === 'number' &&
      s.size > 0 &&
      s.size < 10_000 &&
      typeof s.color === 'string' &&
      COLOR.test(s.color);
    if (!ok) throw new Error('Набросок не похож на набросок');
    return { points: s.points!.map(([x, y]) => [x, y] as [number, number]), size: s.size!, color: s.color!.toLowerCase(), erase: s.erase === true || undefined };
  });
}

/** Задевает ли набросок участок холста */
export function sketchTouches(strokes: SketchStroke[], rect: Rect): boolean {
  const box = shapesBBox(strokes.map((s) => ({ kind: 'stroke', points: s.points, size: s.size, erase: s.erase })));
  return !!box && intersect(box, rect).width > 0 && intersect(box, rect).height > 0;
}

function path(points: [number, number][]): string {
  // Точка — отрезок нулевой длины: со скруглёнными концами он рисуется кружком
  const pts = points.length > 1 ? points : [points[0]!, points[0]!];
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join('');
}

/** SVG наброска на участке холста rect, растянутом до size */
export function sketchSvg(strokes: SketchStroke[], rect: Rect, size: { width: number; height: number }): string {
  const box = `x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}"`;
  let defs = '';
  let body = '';
  strokes.forEach((s, i) => {
    const line = (color: string) =>
      `<path d="${path(s.points)}" fill="none" stroke="${color}" stroke-width="${s.size}" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (s.erase) {
      defs += `<mask id="e${i}" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="white"/>${line('black')}</mask>`;
      body = `<g mask="url(#e${i})">${body}</g>`;
    } else {
      body += line(s.color);
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${rect.x} ${rect.y} ${rect.width} ${rect.height}" preserveAspectRatio="none"><defs>${defs}</defs>${body}</svg>`;
}

/** Набросок поверх картинки для модели: rgb размером size показывает участок холста rect */
export async function drawSketch(rgb: Uint8Array, size: { width: number; height: number }, rect: Rect, strokes: SketchStroke[]): Promise<Uint8Array> {
  const out = await sharp(rgb, { raw: { ...size, channels: 3 } })
    .composite([{ input: Buffer.from(sketchSvg(strokes, rect, size)), left: 0, top: 0 }])
    .removeAlpha()
    .raw()
    .toBuffer();
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

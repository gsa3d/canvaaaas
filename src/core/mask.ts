// Операции над маской: границы выделения, растушёвка внутрь маски, подсветка для модели.
// Маска — один канал 0..255: 0 — не трогать, 255 — перерисовать.
import type { Rect } from './frame.ts';

/** Порог, начиная с которого пиксель маски считается выделенным */
export const MASK_THRESHOLD = 128;

export function maskBBox(mask: Uint8Array, width: number, height: number): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Расстояние от каждого выделенного пикселя до ближайшего невыделенного, в пикселях
 * (двухпроходная фаска 1/√2). У невыделенных — 0. За краем массива невыделенных пикселей нет:
 * выделение, упёршееся в край холста, у края не гаснет.
 */
export function insideDistance(mask: Uint8Array, width: number, height: number): Float32Array {
  const d = new Float32Array(width * height);
  const inf = width + height;
  for (let i = 0; i < d.length; i++) d[i] = mask[i]! >= MASK_THRESHOLD ? inf : 0;
  const diag = Math.SQRT2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = d[i]!;
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1]! + 1);
      if (y > 0) {
        const up = i - width;
        v = Math.min(v, d[up]! + 1);
        if (x > 0) v = Math.min(v, d[up - 1]! + diag);
        if (x < width - 1) v = Math.min(v, d[up + 1]! + diag);
      }
      d[i] = v;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      let v = d[i]!;
      if (v === 0) continue;
      if (x < width - 1) v = Math.min(v, d[i + 1]! + 1);
      if (y < height - 1) {
        const down = i + width;
        v = Math.min(v, d[down]! + 1);
        if (x < width - 1) v = Math.min(v, d[down + 1]! + diag);
        if (x > 0) v = Math.min(v, d[down - 1]! + diag);
      }
      d[i] = v;
    }
  }
  return d;
}

/**
 * Прозрачность вклейки 0..1. Растушёвка идёт только внутрь маски: на границе выделения
 * правка гаснет до нуля, поэтому всё, где маска = 0, остаётся исходным пикселем.
 */
export function featherAlpha(mask: Uint8Array, width: number, height: number, feather: number): Float32Array {
  const alpha = new Float32Array(width * height);
  const dist = feather > 0 ? insideDistance(mask, width, height) : undefined;
  for (let i = 0; i < alpha.length; i++) {
    const m = mask[i]! / 255;
    if (m === 0) continue;
    if (!dist) {
      alpha[i] = m;
      continue;
    }
    const t = Math.min(dist[i]! / feather, 1);
    alpha[i] = m * t * t * (3 - 2 * t);
  }
  return alpha;
}

export interface HighlightStyle {
  color: [number, number, number];
  /** Непрозрачность заливки выделения */
  fill: number;
  /** Толщина контура в пикселях */
  outline: number;
}

export const DEFAULT_HIGHLIGHT: HighlightStyle = { color: [255, 0, 255], fill: 0.35, outline: 4 };

/** Кусок с подсвеченной областью правки: полупрозрачная заливка и контур по краю выделения */
export function highlight(rgb: Uint8Array, mask: Uint8Array, width: number, height: number, style = DEFAULT_HIGHLIGHT): Uint8Array {
  const out = new Uint8Array(rgb);
  const dist = insideDistance(mask, width, height);
  for (let i = 0; i < width * height; i++) {
    if (mask[i]! < MASK_THRESHOLD) continue;
    const a = dist[i]! <= style.outline ? 1 : style.fill;
    for (let c = 0; c < 3; c++) {
      const o = i * 3 + c;
      out[o] = Math.round(rgb[o]! * (1 - a) + style.color[c]! * a);
    }
  }
  return out;
}

/** Кусок, где область правки залита ровным серым — вариант «заполни пустое место» */
export function blankOut(rgb: Uint8Array, mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(rgb);
  for (let i = 0; i < width * height; i++) {
    if (mask[i]! >= MASK_THRESHOLD) out.fill(128, i * 3, i * 3 + 3);
  }
  return out;
}

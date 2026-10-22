// «Расширить маску по правке»: модель часто рисует объект крупнее выделения (крылья мельницы),
// и вклейка срезает его по краю маски. Ищем, где ответ заметно отличается от оригинала
// и примыкает к маске, и добавляем это к маске с запасом на растушёвку.
import { MASK_THRESHOLD, insideDistance } from './mask.ts';

export interface ExpandOptions {
  /** Разница по каналу, начиная с которой пиксель считается изменённым моделью */
  threshold?: number;
  /** Разрывы до стольких пикселей между изменёнными участками считаются одним объектом */
  bridge?: number;
  /** Насколько нарастить найденное, чтобы растушёвка не съела край объекта */
  grow?: number;
}

export interface ExpandResult {
  mask: Uint8Array;
  addedPx: number;
}

export function expandMaskByDiff(
  mask: Uint8Array,
  original: Uint8Array,
  generated: Uint8Array,
  width: number,
  height: number,
  opts: ExpandOptions = {},
): ExpandResult {
  const threshold = opts.threshold ?? 28;
  const bridge = opts.bridge ?? 3;
  const grow = opts.grow ?? 28;
  const n = width * height;

  // Изменённые пиксели как «дыры» маски: расстояние до ближайшего изменённого
  const notChanged = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(generated[i * 3 + c]! - original[i * 3 + c]!));
    notChanged[i] = d > threshold ? 0 : 255;
  }
  const toChanged = insideDistance(notChanged, width, height);

  // Обход от маски по изменённым (с мостиками) пикселям: берём только то, что с маской связано
  const reached = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i]! >= MASK_THRESHOLD) {
      reached[i] = 1;
      queue[tail++] = i;
    }
  }
  const passable = (i: number) => mask[i]! >= MASK_THRESHOLD || toChanged[i]! <= bridge;
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    const y = (i - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
        const j = ny * width + nx;
        if (reached[j] || !passable(j)) continue;
        reached[j] = 1;
        queue[tail++] = j;
      }
    }
  }

  // Наращиваем найденное на grow пикселей
  const notReached = new Uint8Array(n);
  for (let i = 0; i < n; i++) notReached[i] = reached[i] ? 0 : 255;
  const toReached = insideDistance(notReached, width, height);
  const out = new Uint8Array(mask);
  let addedPx = 0;
  for (let i = 0; i < n; i++) {
    if (toReached[i]! <= grow && out[i]! < 255) {
      if (out[i]! < MASK_THRESHOLD) addedPx++;
      out[i] = 255;
    }
  }
  return { mask: out, addedPx };
}

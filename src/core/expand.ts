// «Расширить маску по правке»: модель часто рисует объект крупнее выделения (крылья мельницы),
// и вклейка срезает его по краю маски. Ищем, где ответ заметно отличается от оригинала
// и примыкает к маске, и добавляем это к маске с запасом на растушёвку.
import { MASK_THRESHOLD, insideDistance } from './mask.ts';

export interface ExpandOptions {
  /** Разница по каналу, начиная с которой пиксель считается изменённым моделью */
  threshold?: number;
  /**
   * Сдвиг в столько пикселей изменением не считается: пиксель изменён, только если рядом с ним в другой картинке
   * нет похожего. Модель (ChatGPT особенно) перерисовывает весь кусок со сдвигом линий на пару пикселей —
   * при сравнении пиксель в пиксель изменённым оказывался весь кусок, и маска разливалась по нему целиком
   */
  tolerance?: number;
  /** Разрывы до стольких пикселей между изменёнными участками считаются одним объектом */
  bridge?: number;
  /** Насколько нарастить найденное, чтобы растушёвка не съела край объекта */
  grow?: number;
  /**
   * Края куска, за которыми холст продолжается: к ним маска не подходит вплотную. Растушёвка идёт внутрь маски,
   * и у маски до самого края вклейка обрывалась бы там без неё
   */
  closed?: { left: boolean; top: boolean; right: boolean; bottom: boolean };
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
  const tolerance = opts.tolerance ?? 4;
  const bridge = opts.bridge ?? 3;
  const grow = opts.grow ?? 28;
  const n = width * height;

  // Изменённые пиксели как «дыры» маски: расстояние до ближайшего изменённого
  const changed = changedPixels(original, generated, width, height, threshold, tolerance);
  const notChanged = new Uint8Array(n);
  for (let i = 0; i < n; i++) notChanged[i] = changed[i] ? 0 : 255;
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

  // Наращиваем найденное на grow пикселей, не трогая крайних пикселей у закрытых краёв
  const notReached = new Uint8Array(n);
  for (let i = 0; i < n; i++) notReached[i] = reached[i] ? 0 : 255;
  const toReached = insideDistance(notReached, width, height);
  const { left = false, top = false, right = false, bottom = false } = opts.closed ?? {};
  const out = new Uint8Array(mask);
  let addedPx = 0;
  for (let i = 0; i < n; i++) {
    if (toReached[i]! > grow || out[i]! === 255) continue;
    const x = i % width;
    const y = (i - x) / width;
    if ((left && x === 0) || (top && y === 0) || (right && x === width - 1) || (bottom && y === height - 1)) continue;
    if (out[i]! < MASK_THRESHOLD) addedPx++;
    out[i] = 255;
  }
  return { mask: out, addedPx };
}

/**
 * Где картинки (RGB) различаются больше чем на threshold, если прощать сдвиг до tolerance пикселей: пиксель одной
 * изменён, если по какому-то каналу выходит за пределы того, что есть у другой в квадрате ±tolerance вокруг него.
 * Проверка в обе стороны — иначе пропал бы штрих, который модель стёрла
 */
function changedPixels(a: Uint8Array, b: Uint8Array, width: number, height: number, threshold: number, tolerance: number): Uint8Array {
  const n = width * height;
  const changed = new Uint8Array(n);
  const channel = new Uint8Array(n);
  const low = new Uint8Array(n);
  const high = new Uint8Array(n);
  const tmpLow = new Uint8Array(n);
  const tmpHigh = new Uint8Array(n);
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) channel[i] = from[i * 3 + c]!;
      envelope(channel, low, high, tmpLow, tmpHigh, width, height, tolerance);
      for (let i = 0; i < n; i++) {
        const v = to[i * 3 + c]!;
        if (v < low[i]! - threshold || v > high[i]! + threshold) changed[i] = 1;
      }
    }
  }
  return changed;
}

/** Наименьшее и наибольшее в квадрате ±r вокруг каждого пикселя: по строкам, потом по столбцам */
function envelope(src: Uint8Array, low: Uint8Array, high: Uint8Array, tmpLow: Uint8Array, tmpHigh: Uint8Array, width: number, height: number, r: number): void {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let lo = 255;
      let hi = 0;
      const end = row + Math.min(width - 1, x + r);
      for (let k = row + Math.max(0, x - r); k <= end; k++) {
        const v = src[k]!;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      tmpLow[row + x] = lo;
      tmpHigh[row + x] = hi;
    }
  }
  // По столбцам — строками целиком: так память читается подряд
  for (let y = 0; y < height; y++) {
    const row = y * width;
    low.fill(255, row, row + width);
    high.fill(0, row, row + width);
    for (let k = Math.max(0, y - r); k <= Math.min(height - 1, y + r); k++) {
      const src = k * width;
      for (let x = 0; x < width; x++) {
        if (tmpLow[src + x]! < low[row + x]!) low[row + x] = tmpLow[src + x]!;
        if (tmpHigh[src + x]! > high[row + x]!) high[row + x] = tmpHigh[src + x]!;
      }
    }
  }
}

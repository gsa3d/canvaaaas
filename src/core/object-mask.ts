// «Маска по объекту»: маску объекта в ответе модели у версии рисует сама модель генерации. Просьба — перекрасить кусок
// на месте (объект белым, остальное чёрным), а не нарисовать маску: на «нарисуй маску» ChatGPT рисовал новую картинку
// со своим масштабом и сдвигом, а перекрашенный кусок лежит на прежнем месте. Какой объект, модель видит по подсветке.
import sharp from 'sharp';
import type { GenerateRequest, InputImage, Size } from '../providers/types.ts';
import { chooseImageSize, parseRatio, type ModelOutputs } from './frame.ts';
import { highlight, MASK_THRESHOLD } from './mask.ts';

/** Поля, которыми кусок дополняется до пропорций модели: серые, чтобы модель не приняла их за продолжение рисунка */
const PAD = 128;
/** Сдвиг маски ищется до такой доли большей стороны куска, но не меньше SHIFT_MIN px */
const SHIFT_SHARE = 0.02;
const SHIFT_MIN = 16;
/**
 * Половинам края нужны сдвиги, разошедшиеся больше чем на такую долю расстояния между ними (но не меньше чем на
 * STRETCH_MIN_PX), — картинка растянута. Меньше незаметно: маска шире объекта на контур
 */
const STRETCH_MAX = 0.03;
const STRETCH_MIN_PX = 4;
/**
 * И только если своим сдвигом половина края ложится на рисунок заметно лучше, чем общим: у растянутой картинки при общем
 * сдвиге она мимо контура (свой лучше в разы), а на штриховке свой сдвиг — соседняя линия, лучше на проценты
 */
const STRETCH_GAIN = 1.2;
/** Меньше стольких пикселей края — по нему ничего не понять */
const HALF_MIN = 100;
/** Край длиннее берётся через равные промежутки: столько пикселей хватает, а поиск сдвига идёт по каждому */
const BORDER_MAX = 8000;

const PROMPT = [
  'Edit image 1 in place. Do not redraw, reframe, zoom, crop, shift or resize anything: the output is image 1 with exactly the same framing — every edge stays at the same position relative to the image borders. Only the colors change.',
  'Image 2 is the same picture with a rough magenta highlight around one object.',
  'Recolor image 1 so that every pixel of that whole object (with all the parts that physically belong to it, following its outline exactly, also where it goes beyond the highlight) becomes pure white #FFFFFF, and every other pixel — the ground, stairs, walls, whatever it stands on or touches, the background — becomes pure black #000000.',
  'The result is a flat two-color mask that lies exactly over image 1.',
];
const PADDED = 'The flat grey bands along the borders of the images are padding, not part of the picture: make them black.';

export interface MaskRequest {
  generate: Omit<GenerateRequest, 'signal'>;
  /** Кусок, дополненный до пропорций модели */
  frame: Size;
  /** Где в нём сам кусок */
  at: { x: number; y: number };
  width: number;
  height: number;
}

/**
 * Запрос маски: кусок (RGB width×height) и он же с подсветкой seen — того, что от версии видно, — дополненные серыми
 * полями до ближайших пропорций модели, разрешение — наименьшее, при котором ответ не меньше куска
 */
export async function objectMaskRequest(rgb: Uint8Array, seen: Uint8Array, width: number, height: number, model: ModelOutputs): Promise<MaskRequest> {
  let best: { aspectRatio: string; frame: Size } | undefined;
  for (const aspectRatio of model.aspectRatios) {
    const r = parseRatio(aspectRatio);
    const frame = width / height < r ? { width: Math.round(height * r), height } : { width, height: Math.round(width / r) };
    if (!best || frame.width * frame.height < best.frame.width * best.frame.height) best = { aspectRatio, frame };
  }
  if (!best) throw new Error('У модели нет ни одной пропорции');
  const { aspectRatio, frame } = best;
  const at = { x: Math.floor((frame.width - width) / 2), y: Math.floor((frame.height - height) / 2) };
  const padded = frame.width !== width || frame.height !== height;
  const image = async (pixels: Uint8Array): Promise<InputImage> => {
    const part = sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), { raw: { width, height, channels: 3 } });
    const data = await (padded
      ? part.extend({ left: at.x, top: at.y, right: frame.width - width - at.x, bottom: frame.height - height - at.y, background: { r: PAD, g: PAD, b: PAD } })
      : part
    )
      .jpeg({ quality: 92 })
      .toBuffer();
    return { data, mimeType: 'image/jpeg' };
  };
  return {
    generate: {
      prompt: [...PROMPT, ...(padded ? [PADDED] : [])].join('\n'),
      images: [await image(rgb), await image(highlight(rgb, seen, width, height))],
      aspectRatio,
      imageSize: chooseImageSize(model, aspectRatio, frame, 'auto'),
    },
    frame,
    at,
    width,
    height,
  };
}

/** Ответ модели — маска куска: 255 — объект (светлее середины), 0 — нет */
export async function readObjectMask(generated: Buffer, req: MaskRequest): Promise<Uint8Array> {
  const { frame, at, width, height } = req;
  const gray = await sharp(generated)
    .flatten({ background: '#000000' })
    .resize(frame.width, frame.height, { fit: 'fill', kernel: 'lanczos3' })
    .extract({ left: at.x, top: at.y, width, height })
    .greyscale()
    .raw()
    .toBuffer();
  return Uint8Array.from(gray, (v) => (v >= MASK_THRESHOLD ? 255 : 0));
}

/**
 * Маска, совмещённая с рисунком (rgb того же размера): модель могла сдвинуть картинку на несколько пикселей. Сдвиг —
 * тот, при котором край маски ложится на самые резкие перепады яркости рисунка. Если левой и правой (верхней и нижней)
 * половинам края нужны разные сдвиги, модель картинку растянула, и сдвигом её не совместить — ошибка; так же, если сдвиг
 * дальше, чем ищется. Сдвиг половины ищется только вдоль её оси, по другой — общий, и растяжением считается, только
 * если он ложится заметно лучше общего (STRETCH_GAIN): иначе на рисунке тушью половина края находила себе линии штриховки
 * рядом (±15 px при маске, лёгшей ровно), и ровная маска ChatGPT выходила «растянутой». Край у рамки куска не в счёт:
 * там маску обрезает кусок, а не объект
 */
export function alignMask(mask: Uint8Array, rgb: Uint8Array, width: number, height: number): { mask: Uint8Array; dx: number; dy: number } {
  const n = width * height;
  const reach = Math.max(SHIFT_MIN, Math.round(SHIFT_SHARE * Math.max(width, height)));
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
  const grad = new Float32Array(n);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      grad[i] = Math.hypot(gray[i + 1]! - gray[i - 1]!, gray[i + width]! - gray[i - width]!);
    }
  }
  // Край маски: её пиксели, у которых сосед по стороне — не маска
  let border: number[] = [];
  const m = reach + 1;
  for (let y = m; y < height - m; y++) {
    for (let x = m; x < width - m; x++) {
      const i = y * width + x;
      if (mask[i]! < MASK_THRESHOLD) continue;
      if (mask[i - 1]! < MASK_THRESHOLD || mask[i + 1]! < MASK_THRESHOLD || mask[i - width]! < MASK_THRESHOLD || mask[i + width]! < MASK_THRESHOLD) border.push(i);
    }
  }
  if (border.length > BORDER_MAX) {
    const step = border.length / BORDER_MAX;
    border = Array.from({ length: BORDER_MAX }, (_, k) => border[Math.floor(k * step)]!);
  }
  if (border.length < HALF_MIN) return { mask, dx: 0, dy: 0 };
  const best = (points: number[]) => {
    let out = { dx: 0, dy: 0, k: -1 };
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const d = dy * width + dx;
        let k = 0;
        for (const i of points) k += grad[i + d]!;
        if (k > out.k) out = { dx, dy, k };
      }
    }
    return out;
  };
  const { dx, dy } = best(border);
  if (Math.abs(dx) === reach || Math.abs(dy) === reach) throw new Error('Модель сдвинула картинку, и маска не легла на рисунок: попробуйте ещё раз');
  // Половины края по обе стороны от его середины: каждой — свой сдвиг
  let cx = 0;
  let cy = 0;
  for (const i of border) {
    cx += i % width;
    cy += Math.floor(i / width);
  }
  cx /= border.length;
  cy /= border.length;
  /** Сдвиг половины края вдоль оси axis (по другой оси — общий) и во сколько раз он ложится на рисунок лучше общего */
  const along = (points: number[], axis: 'dx' | 'dy') => {
    let out = { s: 0, k: -1 };
    let common = 0;
    for (let s = -reach; s <= reach; s++) {
      const d = axis === 'dx' ? dy * width + s : s * width + dx;
      let k = 0;
      for (const i of points) k += grad[i + d]!;
      if (k > out.k) out = { s, k };
      if (s === (axis === 'dx' ? dx : dy)) common = k;
    }
    return { s: out.s, gain: common > 0 ? out.k / common : Infinity };
  };
  const stretched = (a: number[], b: number[], axis: 'dx' | 'dy', at: (i: number) => number) => {
    if (a.length < HALF_MIN || b.length < HALF_MIN) return false;
    const mid = (p: number[]) => p.reduce((s, i) => s + at(i), 0) / p.length;
    const [sa, sb] = [along(a, axis), along(b, axis)];
    return Math.abs(sa.s - sb.s) > Math.max(STRETCH_MIN_PX, STRETCH_MAX * Math.abs(mid(b) - mid(a))) && Math.max(sa.gain, sb.gain) > STRETCH_GAIN;
  };
  const column = (i: number) => i % width;
  const row = (i: number) => Math.floor(i / width);
  if (
    stretched(border.filter((i) => column(i) < cx), border.filter((i) => column(i) >= cx), 'dx', column) ||
    stretched(border.filter((i) => row(i) < cy), border.filter((i) => row(i) >= cy), 'dy', row)
  ) {
    throw new Error('Модель растянула картинку, и маска не легла на рисунок: попробуйте ещё раз');
  }
  if (!dx && !dy) return { mask, dx, dy };
  const out = new Uint8Array(n);
  for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y++) {
    out.set(mask.subarray((y - dy) * width + Math.max(0, -dx), (y - dy) * width + Math.min(width, width - dx)), y * width + Math.max(0, dx));
  }
  return { mask: out, dx, dy };
}

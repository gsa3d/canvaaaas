// Правка области: вырезаем кусок с контекстом, отправляем модели, результат возвращаем
// к размеру куска и вклеиваем по маске с растушёвкой. Где маска = 0, пиксели не меняются.
import sharp from 'sharp';
import type { GenerateResult, ImageProvider, InputImage, Size } from '../providers/types.ts';
import { computeFrame, type Frame, type Rect } from './frame.ts';
import { blankOut, featherAlpha, highlight, insideDistance, maskBBox } from './mask.ts';

/**
 * Как показать модели, что менять:
 * pair — чистый кусок + тот же кусок с подсветкой; overlay — только кусок с подсветкой;
 * blank — кусок, где область правки залита серым.
 */
export type Guide = 'pair' | 'overlay' | 'blank';

export interface EditRegionOptions {
  image: string | Buffer;
  mask: string | Buffer;
  prompt: string;
  /** Общий стиль документа, добавляется к каждому запросу */
  style?: string;
  provider: ImageProvider;
  context?: number;
  contextMin?: number;
  feather?: number;
  /** Разрешение ответа модели или auto */
  imageSize?: string;
  guide?: Guide;
}

export interface PreparedEdit {
  provider: ImageProvider;
  canvas: Size;
  channels: 1 | 2 | 3 | 4;
  bbox: Rect;
  frame: Frame;
  imageSize: string;
  modelSize: Size;
  /** Во сколько раз кусок больше ответа модели (больше 1 — детализация падает) */
  scale: number;
  feather: number;
  warnings: string[];
  prompt: string;
  images: InputImage[];
  /** Исходный кусок в размере рамки, RGB — для вклейки и сравнения */
  frameRgb: Buffer;
  /** Маска части рамки внутри холста */
  insideMask: Uint8Array;
  /** Прозрачность вклейки для части рамки внутри холста */
  alpha: Float32Array;
  baseRaw: Buffer;
  lock: { chain: Promise<unknown> };
}

export interface VariantStats {
  /** Средняя разница с оригиналом вне маски (0..255), до вклейки — насколько модель трогала лишнее */
  outsideMae: number;
  outsidePsnr: number;
  /** Доля пикселей вне маски, которые модель заметно изменила (разница больше 24) */
  outsideChangedPct: number;
  /** Сдвиг содержимого ответа относительно куска, в пикселях куска */
  shift: { dx: number; dy: number; maeAtShift: number };
  modelOutput: Size;
}

export interface CompositedVariant {
  /** Полное изображение с вклеенной правкой, PNG */
  image: Buffer;
  /** Правка отдельным слоем: RGBA PNG размером с patchRect, альфа — растушёванная маска */
  patch: Buffer;
  patchRect: Rect;
  stats: VariantStats;
}

const DEFAULTS = { context: 0.3, contextMin: 128, feather: 24, imageSize: 'auto', guide: 'pair' as Guide };
/** Насколько кусок может быть больше ответа модели, прежде чем предупреждать о потере детализации */
const SCALE_WARN = 1.15;

export function buildPrompt(guide: Guide, request: string, style?: string): string {
  const keep =
    'Outside that region keep everything exactly as in the original: same framing and scale, composition, colors, lighting, perspective, line work and level of detail. ' +
    'The new content must blend seamlessly into its surroundings and match the existing style.';
  const intro: Record<Guide, string> = {
    pair:
      'You are retouching one region of a larger illustration.\n' +
      'Image 1 is the current crop. Image 2 is the same crop with the region to change tinted magenta and outlined in magenta.\n' +
      `Return image 1 with ONLY that region redrawn according to the request below. ${keep}\n` +
      'Do not draw any magenta tint, outline, border, text or watermark.',
    overlay:
      'You are retouching one region of a larger illustration.\n' +
      'The image is a crop in which the region to change is tinted magenta and outlined in magenta.\n' +
      `Return the same crop with ONLY that region redrawn according to the request below and with the magenta tint and outline completely removed. ${keep}\n` +
      'Do not draw any border, text or watermark.',
    blank:
      'You are retouching one region of a larger illustration.\n' +
      'The image is a crop in which the region to change is painted flat gray.\n' +
      `Return the same crop with the gray region filled according to the request below, so that no gray patch remains. ${keep}\n` +
      'Do not draw any border, text or watermark.',
  };
  let text = `${intro[guide]}\n\nRequest: ${request}`;
  if (style?.trim()) text += `\nOverall style of the illustration: ${style.trim()}`;
  return text;
}

function chooseImageSize(provider: ImageProvider, aspectRatio: string, frame: Size, requested: string): string {
  if (requested !== 'auto') {
    if (!provider.imageSizes.includes(requested)) {
      throw new Error(`Разрешение ${requested} не поддерживается, есть: ${provider.imageSizes.join(', ')}`);
    }
    return requested;
  }
  for (const size of provider.imageSizes) {
    const out = provider.outputSize(aspectRatio, size);
    if (out.width >= frame.width * 0.95 && out.height >= frame.height * 0.95) return size;
  }
  return provider.imageSizes[provider.imageSizes.length - 1]!;
}

function copyRect(src: Buffer, srcWidth: number, rect: Rect, channels: number): Buffer {
  const out = Buffer.alloc(rect.width * rect.height * channels);
  const rowBytes = rect.width * channels;
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * srcWidth + rect.x) * channels;
    src.copy(out, y * rowBytes, from, from + rowBytes);
  }
  return out;
}

function pasteRect(dst: Buffer, dstWidth: number, rect: Rect, channels: number, src: Buffer): void {
  const rowBytes = rect.width * channels;
  for (let y = 0; y < rect.height; y++) {
    src.copy(dst, ((rect.y + y) * dstWidth + rect.x) * channels, y * rowBytes, (y + 1) * rowBytes);
  }
}

export async function prepareEdit(opts: EditRegionOptions): Promise<PreparedEdit> {
  const { provider } = opts;
  const context = opts.context ?? DEFAULTS.context;
  const contextMin = opts.contextMin ?? DEFAULTS.contextMin;
  const feather = opts.feather ?? DEFAULTS.feather;
  const guide = opts.guide ?? DEFAULTS.guide;

  // 8 бит sRGB: так вклейка и сравнение работают с теми же байтами, что окажутся в PNG
  const { data: baseRaw, info } = await sharp(opts.image, { limitInputPixels: false, autoOrient: true })
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const canvas = { width: info.width, height: info.height };
  const channels = info.channels;

  const { data: maskRaw, info: maskInfo } = await sharp(opts.mask, { limitInputPixels: false })
    .flatten({ background: '#000000' })
    .greyscale()
    .extractChannel(0)
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  if (maskInfo.width !== canvas.width || maskInfo.height !== canvas.height) {
    throw new Error(
      `Маска ${maskInfo.width}×${maskInfo.height} не совпадает по размеру с картинкой ${canvas.width}×${canvas.height}`,
    );
  }
  const mask = new Uint8Array(maskRaw.buffer, maskRaw.byteOffset, maskRaw.length);
  const bbox = maskBBox(mask, canvas.width, canvas.height);
  if (!bbox) throw new Error('Маска пустая: нечего перерисовывать');

  const frame = computeFrame(bbox, canvas, { context, contextMin, aspectRatios: provider.aspectRatios });
  const { rect, inside } = frame;
  const imageSize = chooseImageSize(provider, frame.aspectRatio, rect, opts.imageSize ?? DEFAULTS.imageSize);
  const modelSize = provider.outputSize(frame.aspectRatio, imageSize);
  const scale = Math.max(rect.width / modelSize.width, rect.height / modelSize.height);

  const warnings: string[] = [];
  if (scale > SCALE_WARN) {
    const lastSize = provider.imageSizes[provider.imageSizes.length - 1];
    warnings.push(
      `Кусок ${rect.width}×${rect.height} больше ответа модели ${modelSize.width}×${modelSize.height} в ${scale.toFixed(1)} раза — детализация упадёт. ` +
        (imageSize === lastSize ? 'Выделите область поменьше.' : `Выделите область поменьше или возьмите разрешение ${lastSize}.`),
    );
  }
  if (inside.width < rect.width || inside.height < rect.height) {
    warnings.push('Кусок выходит за край холста, недостающее достроено отражением.');
  }

  // Исходный кусок; поля за холстом — отражение
  const insideRaw = copyRect(baseRaw, canvas.width, inside, channels);
  let frameImg = sharp(insideRaw, { raw: { width: inside.width, height: inside.height, channels } });
  if (inside.width < rect.width || inside.height < rect.height) {
    frameImg = sharp(
      await frameImg
        .extend({
          left: inside.x - rect.x,
          top: inside.y - rect.y,
          right: rect.x + rect.width - inside.x - inside.width,
          bottom: rect.y + rect.height - inside.y - inside.height,
          extendWith: 'mirror',
        })
        .raw()
        .toBuffer(),
      { raw: { width: rect.width, height: rect.height, channels } },
    );
  }
  if (channels === 4) frameImg = frameImg.flatten({ background: '#ffffff' });
  const frameRgb = await frameImg.removeAlpha().raw().toBuffer();

  const insideMask = new Uint8Array(copyRect(maskRaw, canvas.width, inside, 1));
  const frameMask = Buffer.alloc(rect.width * rect.height);
  pasteRect(frameMask, rect.width, { ...inside, x: inside.x - rect.x, y: inside.y - rect.y }, 1, Buffer.from(insideMask));
  const alpha = featherAlpha(insideMask, inside.width, inside.height, feather);

  // То, что увидит модель: кусок и маска в размере её ответа
  const { width: mw, height: mh } = modelSize;
  const modelRgb = new Uint8Array(
    await sharp(frameRgb, { raw: { width: rect.width, height: rect.height, channels: 3 } })
      .resize(mw, mh, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer(),
  );
  const modelMask = new Uint8Array(
    await sharp(frameMask, { raw: { width: rect.width, height: rect.height, channels: 1 } })
      .resize(mw, mh, { fit: 'fill' })
      .extractChannel(0)
      .raw()
      .toBuffer(),
  );
  const jpeg = async (rgb: Uint8Array): Promise<InputImage> => ({
    data: await sharp(rgb, { raw: { width: mw, height: mh, channels: 3 } }).jpeg({ quality: 92 }).toBuffer(),
    mimeType: 'image/jpeg',
  });
  const images: InputImage[] =
    guide === 'pair'
      ? [await jpeg(modelRgb), await jpeg(highlight(modelRgb, modelMask, mw, mh))]
      : guide === 'overlay'
        ? [await jpeg(highlight(modelRgb, modelMask, mw, mh))]
        : [await jpeg(blankOut(modelRgb, modelMask, mw, mh))];

  return {
    provider,
    canvas,
    channels,
    bbox,
    frame,
    imageSize,
    modelSize,
    scale,
    feather,
    warnings,
    prompt: buildPrompt(guide, opts.prompt, opts.style),
    images,
    frameRgb,
    insideMask,
    alpha,
    baseRaw,
    lock: { chain: Promise.resolve() },
  };
}

// Насколько ответ модели отличается от исходного куска там, где менять было нельзя
async function measure(prep: PreparedEdit, gen: Buffer, modelOutput: Size): Promise<VariantStats> {
  const { rect, inside } = prep.frame;
  const ox = inside.x - rect.x;
  const oy = inside.y - rect.y;
  // Сравниваем не ближе 16 px к маске: у самой границы модель имеет право подстроить переход
  const inverted = new Uint8Array(prep.insideMask.length);
  for (let i = 0; i < inverted.length; i++) inverted[i] = 255 - prep.insideMask[i]!;
  const awayFromMask = insideDistance(inverted, inside.width, inside.height);
  const valid = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < inside.height; y++) {
    for (let x = 0; x < inside.width; x++) {
      if (awayFromMask[y * inside.width + x]! > prep.feather + 16) valid[(y + oy) * rect.width + x + ox] = 255;
    }
  }

  let sumAbs = 0;
  let sumSq = 0;
  let changed = 0;
  let count = 0;
  for (let i = 0; i < valid.length; i++) {
    if (!valid[i]) continue;
    let maxDiff = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(gen[i * 3 + c]! - prep.frameRgb[i * 3 + c]!);
      sumAbs += d;
      sumSq += d * d;
      if (d > maxDiff) maxDiff = d;
    }
    if (maxDiff > 24) changed++;
    count++;
  }
  const mse = count ? sumSq / (count * 3) : 0;

  // Сдвиг ищем на уменьшенной копии: перебор смещений в пределах ±6 px
  const small = Math.min(1, 384 / Math.max(rect.width, rect.height));
  const sw = Math.max(1, Math.round(rect.width * small));
  const sh = Math.max(1, Math.round(rect.height * small));
  const shrink = (buf: Buffer | Uint8Array, channels: 1 | 3) =>
    sharp(buf, { raw: { width: rect.width, height: rect.height, channels } })
      .resize(sw, sh, { fit: 'fill', kernel: channels === 1 ? 'nearest' : 'lanczos3' })
      .greyscale()
      .extractChannel(0)
      .raw()
      .toBuffer();
  const [a, b, m] = await Promise.all([shrink(prep.frameRgb, 3), shrink(gen, 3), shrink(valid, 1)]);
  const R = 6;
  let best = { dx: 0, dy: 0, mae: Infinity };
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let s = 0;
      let n = 0;
      for (let y = R; y < sh - R; y++) {
        for (let x = R; x < sw - R; x++) {
          const i = y * sw + x;
          if (!m[i]) continue;
          s += Math.abs(a[i]! - b[(y + dy) * sw + x + dx]!);
          n++;
        }
      }
      const mae = n ? s / n : Infinity;
      if (mae < best.mae) best = { dx, dy, mae };
    }
  }

  return {
    outsideMae: count ? sumAbs / (count * 3) : 0,
    outsidePsnr: mse > 0 ? 10 * Math.log10((255 * 255) / mse) : Infinity,
    outsideChangedPct: count ? (100 * changed) / count : 0,
    shift: { dx: Math.round(best.dx / small), dy: Math.round(best.dy / small), maeAtShift: best.mae },
    modelOutput,
  };
}

/** Вклеить ответ модели: вернуть к размеру куска, смешать по растушёванной маске */
export async function compositeVariant(prep: PreparedEdit, generated: Buffer): Promise<CompositedVariant> {
  const { rect, inside } = prep.frame;
  const { canvas, channels, alpha } = prep;
  const meta = await sharp(generated).metadata();
  const gen = await sharp(generated)
    .flatten({ background: '#ffffff' })
    .resize(rect.width, rect.height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer();
  const stats = await measure(prep, gen, { width: meta.width ?? 0, height: meta.height ?? 0 });

  const original = copyRect(prep.baseRaw, canvas.width, inside, channels);
  const blended = Buffer.from(original);
  const layer = Buffer.alloc(inside.width * inside.height * 4);
  const ox = inside.x - rect.x;
  const oy = inside.y - rect.y;
  for (let y = 0; y < inside.height; y++) {
    for (let x = 0; x < inside.width; x++) {
      const i = y * inside.width + x;
      const g = ((y + oy) * rect.width + x + ox) * 3;
      const a = alpha[i]!;
      for (let c = 0; c < 3; c++) layer[i * 4 + c] = gen[g + c]!;
      layer[i * 4 + 3] = Math.round(a * 255);
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) {
        const o = i * channels + c;
        blended[o] = Math.round(original[o]! + (gen[g + c]! - original[o]!) * a);
      }
    }
  }

  // Полный холст общий для всех вариантов: вклеиваем, кодируем и возвращаем исходные байты по очереди
  const encode = async () => {
    pasteRect(prep.baseRaw, canvas.width, inside, channels, blended);
    try {
      return await sharp(prep.baseRaw, { raw: { ...canvas, channels }, limitInputPixels: false }).png().toBuffer();
    } finally {
      pasteRect(prep.baseRaw, canvas.width, inside, channels, original);
    }
  };
  const turn = prep.lock.chain.then(encode);
  prep.lock.chain = turn.catch(() => undefined);
  const image = await turn;

  const patch = await sharp(layer, { raw: { width: inside.width, height: inside.height, channels: 4 } }).png().toBuffer();
  return { image, patch, patchRect: inside, stats };
}

export type VariantOutcome =
  | ({ index: number; ok: true; generated: GenerateResult } & CompositedVariant)
  | { index: number; ok: false; error: string };

/** Сгенерировать варианты (не больше concurrency одновременно) и вклеить каждый */
export async function runVariants(
  prep: PreparedEdit,
  count: number,
  opts: { concurrency?: number; onProgress?: (msg: string) => void; signal?: AbortSignal } = {},
): Promise<VariantOutcome[]> {
  const results: VariantOutcome[] = [];
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const index = next++;
      opts.onProgress?.(`Вариант ${index + 1}: генерация…`);
      try {
        const generated = await prep.provider.generate({
          prompt: prep.prompt,
          images: prep.images,
          aspectRatio: prep.frame.aspectRatio,
          imageSize: prep.imageSize,
          signal: opts.signal,
        });
        opts.onProgress?.(`Вариант ${index + 1}: готов за ${(generated.elapsedMs / 1000).toFixed(1)} с, вклеиваю…`);
        results[index] = { index, ok: true, generated, ...(await compositeVariant(prep, generated.image)) };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        opts.onProgress?.(`Вариант ${index + 1}: ошибка — ${error}`);
        results[index] = { index, ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 2, count) }, worker));
  return results;
}

// Правка области: вырезаем кусок с контекстом, отправляем модели, результат возвращаем
// к размеру куска и вклеиваем по маске с растушёвкой. Где маска = 0, пиксели не меняются.
import sharp from 'sharp';
import type { GenerateResult, ImageProvider, InputImage, Size } from '../providers/types.ts';
import type { SketchStroke } from '../shared/api.ts';
import { AUTO_SIZE_CAP, chooseImageSize, computeFrame, FRAME_CONTEXT, frameScale, intersect, SCALE_WARN, type Frame, type Rect } from './frame.ts';
import { blankOut, featherAlpha, highlight, insideDistance, maskBBox } from './mask.ts';
import { drawSketch, sketchTouches } from './sketch.ts';

/**
 * Как показать модели, что менять:
 * pair — чистый кусок + тот же кусок с подсветкой; overlay — только кусок с подсветкой;
 * blank — кусок, где область правки залита серым: модель не видит, что там было, и рисует область заново.
 */
export type Guide = 'pair' | 'overlay' | 'blank';

/** Уже раскодированные пиксели: так сервер передаёт холст, не кодируя его в PNG на каждую правку */
export interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/** Пиксели прямоугольника холста rect, построчно */
export interface RawRegion {
  data: Buffer;
  rect: Rect;
  channels: number;
}

function isRaw(v: string | Buffer | RawImage): v is RawImage {
  return typeof v === 'object' && !Buffer.isBuffer(v);
}

export interface EditRegionOptions {
  image: string | Buffer | RawImage;
  /**
   * Маска: файл, PNG или один канал 0..255. Канал может покрывать только участок холста
   * с левым верхним углом в (x, y) — вне участка маска считается нулевой.
   */
  mask: string | Buffer | (RawImage & { x?: number; y?: number });
  prompt: string;
  /** Общий стиль документа, добавляется к каждому запросу */
  style?: string;
  provider: ImageProvider;
  context?: number;
  contextMin?: number;
  feather?: number;
  /** Разрешение ответа модели или auto */
  imageSize?: string;
  /** Потолок для auto: 4K у Nano Banana идёт 4–5 минут, его надо просить явно */
  maxAutoSize?: string;
  guide?: Guide;
  /** Картинки-референсы (персонаж, стиль): уходят модели после куска */
  references?: InputImage[];
  /** Набросок художника: после куска модель получает его же с наброском поверх */
  sketch?: SketchStroke[];
  /**
   * Пиксели части куска внутри холста, если они не те, что в image: так слой перерисовывают
   * по холсту под ним, а не по собственному неудачному результату
   */
  crop?: (inside: Rect) => Buffer;
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
  /** Задача пользователя, стиль, показ области, набросок и референсы — из них собраны prompt и images */
  request: string;
  /** Задача, как её расписал директор: модель получает её вместе со словами пользователя */
  directed?: string;
  style?: string;
  guide: Guide;
  references: InputImage[];
  /** Пустой, если наброска нет или он мимо куска */
  sketch: SketchStroke[];
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
  /** Доля пикселей внутри маски, которые модель заметно изменила: около нуля — правка не случилась */
  insideChangedPct: number;
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

const DEFAULTS = { ...FRAME_CONTEXT, feather: 24, imageSize: 'auto', maxAutoSize: AUTO_SIZE_CAP, guide: 'pair' as Guide };

export interface PromptParts {
  /** Общий стиль документа */
  style?: string;
  /** Сколько референсов идёт после куска */
  references?: number;
  /** После куска идёт он же с наброском художника */
  sketch?: boolean;
  /** Задача, как её расписал директор; тогда request — слова художника, они идут следом как мерило */
  directed?: string;
  /** Шаг с критиком: в области уже прежняя попытка, модель исправляет в ней эти замечания */
  fixes?: string;
}

export function buildPrompt(guide: Guide, request: string, parts: PromptParts = {}): string {
  // Задача — первой и как обязательная: с осторожной формулировкой («верни картинку 1, всё сохрани»)
  // модель на расплывчатых запросах возвращала кусок почти без изменений. Сохранность всего вне маски
  // обеспечивает вклейка, поэтому модели можно смело перерисовывать область целиком.
  const { style, references = 0, sketch = false, directed } = parts;
  const fixes = parts.fixes?.trim();
  const where: Record<Guide, string> = {
    pair: `Image 1 is a crop of a larger illustration. Image 2 is the same crop with the area to edit tinted magenta and outlined. Apply the ${fixes ? 'fixes' : 'task'} to that area of image 1 and return the edited crop.`,
    overlay:
      'The image is a crop of a larger illustration; the area to edit is tinted magenta and outlined. Apply the task to that area and return the edited crop with the magenta tint and outline completely gone.',
    blank:
      'The image is a crop of a larger illustration; the area to edit is painted flat gray, and what was there is hidden on purpose. Paint that area anew following the task and the surroundings, and return the crop with the gray area fully painted, no gray patch left.',
  };
  const lines = [
    fixes
      ? 'Revise this illustration: the area already holds an attempt at the task below. Make every fix listed and keep what already works.'
      : 'Edit this illustration. Carry out the task clearly and completely.',
    '',
    `TASK: ${(directed ?? request).trim()}`,
    ...(directed ? [`(The artist's own words: "${request.trim()}". The task above spells them out; where the two disagree, follow the artist's words.)`] : []),
    ...(fixes ? ['', 'FIX:', fixes] : []),
    '',
    where[guide],
    fixes
      ? '- Inside the area: make the fixes fully and visibly; leave the rest of the attempt as it is.'
      : '- Inside the area: make the change fully and visibly; redraw whatever is needed there.',
    '- Outside the area: keep the picture as it is, with the same framing and scale, so the edit lines up with its surroundings.',
    '- Match the existing style, line work, lighting and perspective so the edit blends in seamlessly.',
    `- Do not draw ${guide === 'blank' ? 'any' : 'the magenta tint, the outline or any'} borders, text or watermarks.`,
  ];
  // Картинки по порядку: кусок (у pair — ещё он же с подсветкой), кусок с наброском, референсы
  const crops = guide === 'pair' ? 2 : 1;
  if (sketch) {
    lines.push(
      `- Image ${crops + 1} is the same crop with the artist's rough sketch drawn over it: it shows where the task goes and its rough shape, size and pose. Follow it for placement and proportions, but draw properly in the illustration's style; its colors are only a hint, and no sketch strokes may remain.`,
    );
  }
  if (references > 0) {
    const first = crops + (sketch ? 1 : 0) + 1;
    const range = references === 1 ? `Image ${first} is a reference image` : `Images ${first}–${first + references - 1} are reference images`;
    lines.push(`- ${range} from the artist: use them as visual reference for what the task mentions (characters, objects, style); do not copy their framing or paste them in whole.`);
  }
  if (style?.trim()) lines.push('', `Style of the whole illustration: ${style.trim()}`);
  return lines.join('\n');
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
  const { data: baseRaw, info } = isRaw(opts.image)
    ? { data: opts.image.data, info: opts.image }
    : await sharp(opts.image, { limitInputPixels: false, autoOrient: true })
        .toColourspace('srgb')
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true });
  const canvas = { width: info.width, height: info.height };
  const channels = info.channels;

  const { data: maskRaw, info: maskInfo } = isRaw(opts.mask)
    ? { data: opts.mask.data, info: opts.mask }
    : await sharp(opts.mask, { limitInputPixels: false })
        .flatten({ background: '#000000' })
        .greyscale()
        .extractChannel(0)
        .raw({ depth: 'uchar' })
        .toBuffer({ resolveWithObject: true });
  if (maskInfo.channels !== 1) throw new Error('Маска должна быть одним каналом');
  const maskRect: Rect = {
    x: isRaw(opts.mask) ? (opts.mask.x ?? 0) : 0,
    y: isRaw(opts.mask) ? (opts.mask.y ?? 0) : 0,
    width: maskInfo.width,
    height: maskInfo.height,
  };
  const partial = maskRect.x !== 0 || maskRect.y !== 0 || maskRect.width !== canvas.width || maskRect.height !== canvas.height;
  if (partial && isRaw(opts.mask) && opts.mask.x !== undefined) {
    if (maskRect.x < 0 || maskRect.y < 0 || maskRect.x + maskRect.width > canvas.width || maskRect.y + maskRect.height > canvas.height) {
      throw new Error('Участок маски выходит за холст');
    }
  } else if (partial) {
    throw new Error(
      `Маска ${maskInfo.width}×${maskInfo.height} не совпадает по размеру с картинкой ${canvas.width}×${canvas.height}`,
    );
  }
  const mask = new Uint8Array(maskRaw.buffer, maskRaw.byteOffset, maskRaw.length);
  const localBox = maskBBox(mask, maskRect.width, maskRect.height);
  if (!localBox) throw new Error('Маска пустая: нечего перерисовывать');
  const bbox = { ...localBox, x: localBox.x + maskRect.x, y: localBox.y + maskRect.y };

  const frame = computeFrame(bbox, canvas, { context, contextMin, aspectRatios: provider.aspectRatios });
  const { rect, inside } = frame;
  const imageSize = chooseImageSize(
    provider,
    frame.aspectRatio,
    rect,
    opts.imageSize ?? DEFAULTS.imageSize,
    opts.maxAutoSize ?? DEFAULTS.maxAutoSize,
  );
  const modelSize = provider.outputSize(frame.aspectRatio, imageSize);
  const scale = frameScale(rect, modelSize);

  const warnings: string[] = [];
  // Что с этим делать, интерфейс подсказывает ещё до генерации — здесь только факт
  if (scale > SCALE_WARN) {
    warnings.push(`Кусок ${rect.width}×${rect.height} больше ответа ${modelSize.width}×${modelSize.height} в ${scale.toFixed(1).replace('.', ',')} раза — детализация упадёт`);
  }
  if (inside.width < rect.width || inside.height < rect.height) {
    warnings.push('Кусок выходит за край холста: недостающее достроено отражением');
  }

  // Исходный кусок; поля за холстом — отражение
  const insideRaw = opts.crop ? opts.crop(inside) : copyRect(baseRaw, canvas.width, inside, channels);
  if (insideRaw.length !== inside.width * inside.height * channels) throw new Error('Кусок не того размера');
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

  // Маска части рамки внутри холста; вне участка маски — нули
  const insideMask = new Uint8Array(inside.width * inside.height);
  const overlap = intersect(inside, maskRect);
  for (let row = 0; row < overlap.height; row++) {
    const from = (overlap.y - maskRect.y + row) * maskRect.width + overlap.x - maskRect.x;
    insideMask.set(mask.subarray(from, from + overlap.width), (overlap.y - inside.y + row) * inside.width + overlap.x - inside.x);
  }
  const alpha = featherAlpha(insideMask, inside.width, inside.height, feather);
  const references = opts.references ?? [];
  let sketch = opts.sketch ?? [];
  if (sketch.length && !sketchTouches(sketch, rect)) {
    warnings.push('Набросок не задевает кусок — модель его не увидит');
    sketch = [];
  }
  const images = await guideImages(frameRgb, insideMask, frame, modelSize, guide, sketch);

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
    request: opts.prompt,
    style: opts.style,
    guide,
    references,
    sketch,
    prompt: buildPrompt(guide, opts.prompt, { style: opts.style, references: references.length, sketch: sketch.length > 0 }),
    images: [...images, ...references],
    frameRgb,
    insideMask,
    alpha,
    baseRaw,
    lock: { chain: Promise.resolve() },
  };
}

/** То, что увидит модель: кусок и маска в размере её ответа, показанные по guide, и кусок с наброском, если он есть */
async function guideImages(frameRgb: Buffer, insideMask: Uint8Array, frame: Frame, modelSize: Size, guide: Guide, sketch: SketchStroke[]): Promise<InputImage[]> {
  const { rect, inside } = frame;
  const frameMask = Buffer.alloc(rect.width * rect.height);
  pasteRect(frameMask, rect.width, { ...inside, x: inside.x - rect.x, y: inside.y - rect.y }, 1, Buffer.from(insideMask));
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
  // Набросок рисуется поверх того куска, который модель правит
  const first = guide === 'pair' ? modelRgb : guide === 'overlay' ? highlight(modelRgb, modelMask, mw, mh) : blankOut(modelRgb, modelMask, mw, mh);
  const images = [await jpeg(first)];
  if (guide === 'pair') images.push(await jpeg(highlight(modelRgb, modelMask, mw, mh)));
  if (sketch.length) images.push(await jpeg(await drawSketch(first, modelSize, rect, sketch)));
  return images;
}

/** Картинки директору и критику — не больше этого по большей стороне: им нужно понять кусок, а не разглядеть пиксели */
const DIRECTOR_SIZE = 1280;

function directorSize(prep: PreparedEdit): Size {
  const k = Math.min(1, DIRECTOR_SIZE / Math.max(prep.modelSize.width, prep.modelSize.height));
  return { width: Math.max(1, Math.round(prep.modelSize.width * k)), height: Math.max(1, Math.round(prep.modelSize.height * k)) };
}

/**
 * Что видит директор: чистый кусок, он же с подсветкой области, с наброском, если он есть, весь холст (overview) и референсы.
 * Кусок он видит всегда, даже если модели его скроют: так ему понятнее, что вокруг и что заменить.
 */
export async function directorImages(prep: PreparedEdit, overview?: InputImage): Promise<InputImage[]> {
  const crop = await guideImages(prep.frameRgb, prep.insideMask, prep.frame, directorSize(prep), 'pair', prep.sketch);
  return [...crop, ...(overview ? [overview] : []), ...prep.references];
}

/**
 * Что видит критик: кусок до правки, он же с подсветкой области mask, кусок после правки (after — в размере рамки, RGB),
 * до правки с наброском, весь холст и референсы.
 */
export async function criticImages(prep: PreparedEdit, after: Buffer, mask: Uint8Array, overview?: InputImage): Promise<InputImage[]> {
  const size = directorSize(prep);
  const { rect } = prep.frame;
  const [clean, marked, ...sketched] = await guideImages(prep.frameRgb, mask, prep.frame, size, 'pair', prep.sketch);
  const result: InputImage = {
    data: await sharp(after, { raw: { width: rect.width, height: rect.height, channels: 3 } })
      .resize(size.width, size.height, { fit: 'fill', kernel: 'lanczos3' })
      .jpeg({ quality: 92 })
      .toBuffer(),
    mimeType: 'image/jpeg',
  };
  return [clean!, marked!, result, ...sketched, ...(overview ? [overview] : []), ...prep.references];
}

/** Кусок, каким он станет с вариантом: ответ модели по растушёванной маске поверх исходного, в размере рамки, RGB */
export function blendFrame(prep: PreparedEdit, gen: Buffer, alpha: Float32Array): Buffer {
  const { rect, inside } = prep.frame;
  const out = Buffer.from(prep.frameRgb);
  for (let y = 0; y < inside.height; y++) {
    for (let x = 0; x < inside.width; x++) {
      const a = alpha[y * inside.width + x]!;
      if (a === 0) continue;
      const i = ((y + inside.y - rect.y) * rect.width + x + inside.x - rect.x) * 3;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(out[i + c]! + (gen[i + c]! - out[i + c]!) * a);
    }
  }
  return out;
}

/**
 * Шаг с критиком: модель получает кусок с прежней попыткой (ответ gen, вклеенный по маске) и исправляет в ней замечания fixes.
 * Область ей всегда видна, даже если первый шаг шёл со скрытым под маской: исправлять надо то, что уже нарисовано.
 * Задача — как сейчас в prep (слова художника и текст директора), кусок, набросок и референсы прежние.
 */
export async function revise(prep: PreparedEdit, gen: Buffer, alpha: Float32Array, mask: Uint8Array, fixes: string): Promise<{ prompt: string; images: InputImage[] }> {
  const attempt = blendFrame(prep, gen, alpha);
  const images = [...(await guideImages(attempt, mask, prep.frame, prep.modelSize, 'pair', prep.sketch)), ...prep.references];
  const prompt = buildPrompt('pair', prep.request, {
    style: prep.style,
    references: prep.references.length,
    sketch: prep.sketch.length > 0,
    directed: prep.directed,
    fixes,
  });
  return { prompt, images };
}

/** Весь холст в уменьшенной копии thumb с рамкой куска rect — чтобы директор видел, что это за картина и где кусок */
export async function overviewImage(thumb: Buffer, canvas: Size, rect: Rect): Promise<InputImage> {
  const { width = 1, height = 1 } = await sharp(thumb).metadata();
  const k = width / canvas.width;
  const line = Math.max(2, Math.round(Math.max(width, height) / 300));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="${rect.x * k}" y="${rect.y * k}" width="${rect.width * k}" height="${rect.height * k}" fill="none" stroke="#ff00ff" stroke-width="${line}"/></svg>`;
  return { data: await sharp(thumb).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).jpeg({ quality: 85 }).toBuffer(), mimeType: 'image/jpeg' };
}

/**
 * Та же правка с другой задачей, другим показом области (например, со стёртым под маской) или задачей, расписанной
 * директором: кусок, маска, набросок и разрешение прежние, заново собираются только промпт и картинки для модели.
 */
export async function retarget(
  prep: PreparedEdit,
  change: { request: string; guide: Guide; directed?: string },
): Promise<Pick<PreparedEdit, 'request' | 'guide' | 'directed' | 'prompt' | 'images'>> {
  const images =
    change.guide === prep.guide
      ? prep.images
      : [...(await guideImages(prep.frameRgb, prep.insideMask, prep.frame, prep.modelSize, change.guide, prep.sketch)), ...prep.references];
  const prompt = buildPrompt(change.guide, change.request, {
    style: prep.style,
    references: prep.references.length,
    sketch: prep.sketch.length > 0,
    directed: change.directed,
  });
  return { request: change.request, guide: change.guide, directed: change.directed, prompt, images };
}

// Насколько ответ модели отличается от исходного куска там, где менять было нельзя
export async function measure(prep: PreparedEdit, gen: Buffer, modelOutput: Size): Promise<VariantStats> {
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

  let insideTotal = 0;
  let insideChanged = 0;
  for (let y = 0; y < inside.height; y++) {
    for (let x = 0; x < inside.width; x++) {
      if (prep.insideMask[y * inside.width + x]! < 128) continue;
      const i = ((y + oy) * rect.width + x + ox) * 3;
      insideTotal++;
      for (let c = 0; c < 3; c++) {
        if (Math.abs(gen[i + c]! - prep.frameRgb[i + c]!) > 24) {
          insideChanged++;
          break;
        }
      }
    }
  }

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
    insideChangedPct: insideTotal ? (100 * insideChanged) / insideTotal : 0,
    modelOutput,
  };
}

/** Ответ модели, возвращённый к размеру рамки куска: RGB, Lanczos */
export async function fitGenerated(prep: PreparedEdit, generated: Buffer): Promise<{ gen: Buffer; modelOutput: Size }> {
  const { rect } = prep.frame;
  const meta = await sharp(generated).metadata();
  const gen = await sharp(generated)
    .flatten({ background: '#ffffff' })
    .resize(rect.width, rect.height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer();
  return { gen, modelOutput: { width: meta.width ?? 0, height: meta.height ?? 0 } };
}

/** Часть RGB-буфера размером с рамку, которая лежит внутри холста */
export function insideOf(prep: PreparedEdit, frameBuf: Buffer): Buffer {
  const { rect, inside } = prep.frame;
  return copyRect(frameBuf, rect.width, { ...inside, x: inside.x - rect.x, y: inside.y - rect.y }, 3);
}

/**
 * Принятый слой как ответ модели в размере рамки: его цвета там, где он лежит, вокруг — исходный кусок.
 * Так уже принятый вариант стоит в одном ряду с новыми, когда слой перерисовывают ещё раз.
 */
export function layerAsGen(prep: PreparedEdit, layerRect: Rect, layer: Buffer): Buffer {
  const { rect } = prep.frame;
  const gen = Buffer.from(prep.frameRgb);
  const overlap = intersect(prep.frame.inside, layerRect);
  for (let y = overlap.y; y < overlap.y + overlap.height; y++) {
    for (let x = overlap.x; x < overlap.x + overlap.width; x++) {
      const l = ((y - layerRect.y) * layerRect.width + x - layerRect.x) * 4;
      const g = ((y - rect.y) * rect.width + x - rect.x) * 3;
      gen[g] = layer[l]!;
      gen[g + 1] = layer[l + 1]!;
      gen[g + 2] = layer[l + 2]!;
    }
  }
  return gen;
}

/** Слой правки: RGBA размером с часть рамки внутри холста, альфа — растушёванная маска */
export function buildLayer(prep: PreparedEdit, gen: Buffer, alpha: Float32Array): Buffer {
  const rgb = insideOf(prep, gen);
  const { inside } = prep.frame;
  const layer = Buffer.alloc(inside.width * inside.height * 4);
  for (let i = 0; i < inside.width * inside.height; i++) {
    layer[i * 4] = rgb[i * 3]!;
    layer[i * 4 + 1] = rgb[i * 3 + 1]!;
    layer[i * 4 + 2] = rgb[i * 3 + 2]!;
    layer[i * 4 + 3] = Math.round(alpha[i]! * 255);
  }
  return layer;
}

/**
 * Наложить слой правки (RGBA, прямоугольник layerRect) на пиксели dst — только в их пересечении.
 * Где альфа слоя 0, байты dst не трогаются; альфа-канал dst, если есть, не меняется.
 */
export function applyLayer(dst: RawRegion, layerRect: Rect, layer: Buffer): void {
  const x0 = Math.max(dst.rect.x, layerRect.x);
  const y0 = Math.max(dst.rect.y, layerRect.y);
  const x1 = Math.min(dst.rect.x + dst.rect.width, layerRect.x + layerRect.width);
  const y1 = Math.min(dst.rect.y + dst.rect.height, layerRect.y + layerRect.height);
  const ch = dst.channels;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = ((y - layerRect.y) * layerRect.width + x - layerRect.x) * 4;
      const a = layer[l + 3]!;
      if (a === 0) continue;
      const d = ((y - dst.rect.y) * dst.rect.width + x - dst.rect.x) * ch;
      for (let c = 0; c < 3; c++) {
        const o = dst.data[d + c]!;
        dst.data[d + c] = Math.round(o + ((layer[l + c]! - o) * a) / 255);
      }
    }
  }
}

/** Вклеить ответ модели в полное изображение (для CLI): вернуть к размеру куска, смешать по маске */
export async function compositeVariant(prep: PreparedEdit, generated: Buffer): Promise<CompositedVariant> {
  const { inside } = prep.frame;
  const { canvas, channels } = prep;
  const { gen, modelOutput } = await fitGenerated(prep, generated);
  const stats = await measure(prep, gen, modelOutput);
  const layer = buildLayer(prep, gen, prep.alpha);

  // Полный холст общий для всех вариантов: вклеиваем, кодируем и возвращаем исходные байты по очереди
  const encode = async () => {
    const original = copyRect(prep.baseRaw, canvas.width, inside, channels);
    applyLayer({ data: prep.baseRaw, rect: { x: 0, y: 0, ...canvas }, channels }, inside, layer);
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

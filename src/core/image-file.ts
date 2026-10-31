// Файл картинки на диске: можно ли перезаписать его без потерь и как записать в него холст.
// Холст внутри — sRGB 8 бит без прозрачности. Если исходник был другим (прозрачность, 16 бит,
// другой цветовой профиль, возможные слои TIFF), перезапись испортила бы и то, что вне правок, —
// тогда «Сохранить» предлагает сохранить под другим именем.
import { randomUUID } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import sharp from 'sharp';
import type { RawImage } from './edit-region.ts';
import { L } from '../shared/i18n.ts';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'tiff';

export interface ImageFile {
  path: string;
  format: ImageFormat;
  /** Разрешение для печати, точек на дюйм */
  density?: number;
  /** Прореживание цвета у JPEG исходника: при перезаписи сохраняется таким же */
  chromaSubsampling?: string;
  /** Почему файл нельзя перезаписать без потерь; нет — можно */
  blocker?: string;
  /** Размер и время изменения на момент открытия или сохранения: так видно, что файл поменяла другая программа */
  size: number;
  mtimeMs: number;
}

const EXTENSIONS: Record<string, ImageFormat> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.tif': 'tiff',
  '.tiff': 'tiff',
};

export const IMAGE_EXTENSIONS = Object.keys(EXTENSIONS).map((e) => e.slice(1));

export function formatOf(path: string): ImageFormat | null {
  return EXTENSIONS[extname(path).toLowerCase()] ?? null;
}

/** Название ICC-профиля из тега desc: «sRGB IEC61966-2.1», «Display P3»…; пустая строка, если не прочитать */
export function iccDescription(icc: Buffer): string {
  try {
    const count = icc.readUInt32BE(128);
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12;
      if (icc.toString('latin1', entry, entry + 4) !== 'desc') continue;
      const tag = icc.readUInt32BE(entry + 4);
      const type = icc.toString('latin1', tag, tag + 4);
      if (type === 'desc') {
        const length = icc.readUInt32BE(tag + 8);
        return icc.toString('latin1', tag + 12, tag + 12 + length).replace(/\0+$/, '').trim();
      }
      if (type === 'mluc') {
        // ICC v4: первая запись списка строк, UTF-16BE
        const length = icc.readUInt32BE(tag + 20);
        const start = tag + icc.readUInt32BE(tag + 24);
        return Buffer.from(icc.subarray(start, start + length - (length % 2)))
          .swap16()
          .toString('utf16le')
          .replace(/\0+$/, '')
          .trim();
      }
    }
  } catch {
    // битый профиль — описание неизвестно
  }
  return '';
}

/** Что за файл открыт и можно ли потом записать холст поверх него без потерь */
export async function inspectImage(path: string): Promise<ImageFile> {
  const [info, meta] = await Promise.all([stat(path), sharp(path, { limitInputPixels: false }).metadata()]);
  const reasons: string[] = [];
  const format = meta.format;
  const writable = format === 'png' || format === 'jpeg' || format === 'webp' || format === 'tiff';
  if (!writable) reasons.push(L(`формат ${String(meta.format).toUpperCase()} canvaaaas не записывает`, `canvaaaas cannot write ${String(meta.format).toUpperCase()} files`));
  if (format === 'tiff') reasons.push(L('в TIFF могут быть слои Photoshop, которых canvaaaas не видит', 'a TIFF may contain Photoshop layers that canvaaaas does not see'));
  if ((meta.pages ?? 1) > 1) reasons.push(L('в файле несколько кадров или страниц', 'the file has several frames or pages'));
  if (meta.depth && meta.depth !== 'uchar' && meta.depth !== 'char') reasons.push(L('в файле больше 8 бит на канал', 'the file has more than 8 bits per channel'));
  if (meta.space === 'cmyk') reasons.push(L('файл в CMYK', 'the file is CMYK'));
  if (meta.icc) {
    const profile = iccDescription(meta.icc);
    if (!/srgb/i.test(profile)) reasons.push(profile ? L(`цветовой профиль «${profile}», а холст в sRGB`, `the color profile is “${profile}”, but the canvas is sRGB`) : L('неизвестный цветовой профиль', 'unknown color profile'));
  }
  if (meta.hasAlpha && !(await sharp(path, { limitInputPixels: false }).stats()).isOpaque) {
    reasons.push(L('в файле есть прозрачность, а холст непрозрачный', 'the file has transparency, but the canvas is opaque'));
  }
  return {
    path,
    format: writable ? format : 'png',
    density: meta.density,
    chromaSubsampling: meta.chromaSubsampling,
    blocker: reasons.length ? L(`Перезаписать «${basename(path)}» без потерь нельзя: ${reasons.join('; ')}.`, `“${basename(path)}” cannot be overwritten without loss: ${reasons.join('; ')}.`) : undefined,
    size: info.size,
    mtimeMs: info.mtimeMs,
  };
}

/** Холст (RGB 8 бит) в файл нужного формата. sRGB-профиль и разрешение для печати записываются в файл */
export function encodeImage(image: RawImage, format: ImageFormat, opts: { density?: number; chromaSubsampling?: string } = {}): Promise<Buffer> {
  const img = sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: image.channels },
    limitInputPixels: false,
  }).withMetadata(opts.density ? { density: opts.density } : {});
  switch (format) {
    case 'png':
      return img.png().toBuffer();
    case 'jpeg':
      return img.jpeg({ quality: 95, chromaSubsampling: opts.chromaSubsampling === '4:2:0' ? '4:2:0' : '4:4:4' }).toBuffer();
    case 'webp':
      return img.webp({ lossless: true, effort: 2 }).toBuffer();
    case 'tiff':
      return img.tiff({ compression: 'lzw', predictor: 'horizontal' }).toBuffer();
  }
}

/** Запись через временный файл рядом: если что-то пойдёт не так, старый файл останется целым */
export async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// Главный инвариант: всё, где маска = 0, после правки побайтно равно оригиналу.
// Проверяется на холсте 8000×6000 с подставной моделью, которая инвертирует весь кусок.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { compositeVariant, prepareEdit } from '../src/core/edit-region.ts';
import { renderMask, type MaskShape } from '../src/core/mask-shapes.ts';
import { mockProvider } from '../src/providers/mock.ts';

async function makeBase(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = (x * 7 + y) & 255;
      raw[i + 1] = (y * 5 + (x >> 3)) & 255;
      raw[i + 2] = ((x ^ y) * 3) & 255;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 }, limitInputPixels: false })
    .png({ compressionLevel: 1 })
    .toBuffer();
}

async function decode(png: Buffer): Promise<Buffer> {
  return sharp(png, { limitInputPixels: false }).raw().toBuffer();
}

async function editAndCompare(base: Buffer, width: number, height: number, shapes: MaskShape[]) {
  const maskPng = await renderMask(width, height, shapes);
  const mask = await sharp(maskPng, { limitInputPixels: false }).extractChannel(0).raw().toBuffer();
  const provider = mockProvider();
  const prep = await prepareEdit({ image: base, mask: maskPng, prompt: 'test', provider, imageSize: '2K' });
  const generated = await provider.generate({
    prompt: prep.prompt,
    images: prep.images,
    aspectRatio: prep.frame.aspectRatio,
    imageSize: prep.imageSize,
  });
  const { image } = await compositeVariant(prep, generated.image);

  const meta = await sharp(image, { limitInputPixels: false }).metadata();
  expect([meta.width, meta.height, meta.channels]).toEqual([width, height, 3]);
  const before = await decode(base);
  const after = await decode(image);
  let changedOutside = 0;
  let changedInside = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * 3;
    const same = before[o] === after[o] && before[o + 1] === after[o + 1] && before[o + 2] === after[o + 2];
    if (same) continue;
    if (mask[i] === 0) changedOutside++;
    else changedInside++;
  }
  return { prep, changedOutside, changedInside };
}

describe('edit-region', () => {
  it('8000×6000: вне маски ни один пиксель не меняется, внутри — меняется', async () => {
    const base = await makeBase(8000, 6000);
    const { changedOutside, changedInside } = await editAndCompare(base, 8000, 6000, [
      { kind: 'ellipse', cx: 5200, cy: 2900, rx: 700, ry: 450 },
      { kind: 'polygon', points: [[4300, 3200], [4700, 3700], [4100, 3900]] },
      { kind: 'stroke', points: [[4500, 2500], [5000, 2300], [5600, 2600]], size: 60 },
      { kind: 'stroke', points: [[5000, 2700], [5400, 3100]], size: 80, erase: true },
    ]);
    expect(changedOutside).toBe(0);
    expect(changedInside).toBeGreaterThan(500_000);
  }, 180_000);

  it('панорама: кусок выходит за холст и достраивается отражением, инвариант тот же', async () => {
    const base = await makeBase(6000, 400);
    const { prep, changedOutside, changedInside } = await editAndCompare(base, 6000, 400, [
      { kind: 'rect', x: 0, y: 100, width: 5999, height: 200 },
    ]);
    const { rect, inside } = prep.frame;
    expect(rect.width * rect.height).toBeGreaterThan(inside.width * inside.height);
    expect(prep.warnings.join(' ')).toContain('отражением');
    expect(changedOutside).toBe(0);
    expect(changedInside).toBeGreaterThan(500_000);
  }, 180_000);
});

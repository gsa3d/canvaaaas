import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CanvasDocument } from '../src/core/document.ts';
import { applyLayer } from '../src/core/edit-region.ts';

function layer(width: number, height: number, color: [number, number, number], alpha: number): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) buf.set([...color, alpha], i * 4);
  return buf;
}

function patch(id: string, x: number, y: number, size: number, color: [number, number, number], alpha = 200) {
  return { id, rect: { x, y, width: size, height: size }, layer: layer(size, size, color, alpha), prompt: id, jobId: id, variant: 0, createdAt: '' };
}

describe('CanvasDocument', () => {
  it('откат, повтор и выключение правок пересобирают холст точно', () => {
    const doc = CanvasDocument.blank(1500, 1100, [10, 20, 30], 'test');
    const a = patch('a', 100, 100, 600, [200, 0, 0]);
    const b = patch('b', 400, 400, 600, [0, 200, 0]);

    doc.addPatch(a);
    const afterA = Buffer.from(doc.composite);
    doc.addPatch(b);
    const afterAB = Buffer.from(doc.composite);

    // Ожидаемый холст «только b» — из исходника
    const onlyB = Buffer.from(doc.base);
    applyLayer({ data: onlyB, rect: { x: 0, y: 0, width: 1500, height: 1100 }, channels: 3 }, b.rect, b.layer);

    doc.togglePatch('a');
    expect(doc.composite.equals(onlyB)).toBe(true);
    doc.undo();
    expect(doc.composite.equals(afterAB)).toBe(true);
    doc.undo();
    expect(doc.composite.equals(afterA)).toBe(true);
    doc.undo();
    expect(doc.composite.equals(doc.base)).toBe(true);
    expect(doc.canUndo).toBe(false);
    doc.redo();
    doc.redo();
    expect(doc.composite.equals(afterAB)).toBe(true);
  });

  it('тайлы уменьшенных уровней обновляются после правки', async () => {
    const doc = CanvasDocument.blank(2000, 1000, [0, 0, 0], 'test');
    expect(doc.levelCount).toBe(3);
    const before = await sharp(await doc.tile(2, 0, 0)).raw().toBuffer();
    doc.addPatch(patch('w', 0, 0, 1000, [255, 255, 255], 255));
    const after = await sharp(await doc.tile(2, 0, 0)).raw().toBuffer();
    expect(before[0]).toBeLessThan(10);
    expect(after[0]).toBeGreaterThan(245);
  });

  it('тайл, который кодировался, пока холст менялся, не остаётся в кэше устаревшим', async () => {
    const doc = CanvasDocument.blank(1000, 1000, [0, 0, 0], 'test');
    doc.addPatch(patch('w', 0, 0, 600, [255, 255, 255], 255));
    // Тайл просят, а пока он кодируется, версию скрывают (так же — смена версии слоя или мазок по маске)
    const inFlight = doc.tile(0, 0, 0);
    doc.togglePatch('w');
    expect((await sharp(await inFlight).raw().toBuffer())[0]).toBeGreaterThan(245);
    const now = await sharp(await doc.tile(0, 0, 0)).raw().toBuffer();
    expect(now[0]).toBeLessThan(10);
  });
});

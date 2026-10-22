import { describe, expect, it } from 'vitest';
import { expandMaskByDiff } from '../src/core/expand.ts';
import { applyShapes } from '../src/core/mask-shapes.ts';

describe('applyShapes', () => {
  it('добавляет и стирает фигуры в координатах холста, отсекая всё за пределами участка', async () => {
    const rect = { x: 50, y: 50, width: 100, height: 100 };
    let mask: Uint8Array = new Uint8Array(rect.width * rect.height);
    mask = await applyShapes(mask, rect, [
      { kind: 'rect', x: 0, y: 0, width: 100, height: 100 },
      { kind: 'rect', x: 70, y: 70, width: 20, height: 20, erase: true },
    ]);
    const at = (x: number, y: number) => mask[(y - rect.y) * rect.width + (x - rect.x)];
    expect(at(55, 55)).toBe(255);
    expect(at(80, 80)).toBe(0);
    expect(at(120, 120)).toBe(0);
  });
});

describe('expandMaskByDiff', () => {
  it('забирает в маску то, что модель нарисовала за краем выделения, но не далёкий шум', () => {
    const w = 200;
    const h = 200;
    const original = new Uint8Array(w * h * 3).fill(100);
    const generated = new Uint8Array(original);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const r = Math.hypot(x - 100, y - 100);
        if (r <= 30) mask[i] = 255;
        if (r <= 50) generated.fill(220, i * 3, i * 3 + 3);
        if (x < 6 && y < 6) generated.fill(0, i * 3, i * 3 + 3);
      }
    }
    const { mask: out, addedPx } = expandMaskByDiff(mask, original, generated, w, h, { grow: 4 });
    expect(addedPx).toBeGreaterThan(0);
    expect(out[100 * w + 100 + 48]).toBe(255);
    expect(out[3 * w + 3]).toBe(0);
    expect(out[100 * w + 100 + 70]).toBe(0);
  });
});

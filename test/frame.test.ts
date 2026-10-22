import { describe, expect, it } from 'vitest';
import { computeFrame, parseRatio, type Rect } from '../src/core/frame.ts';

const RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const opts = { context: 0.3, contextMin: 128, aspectRatios: RATIOS };

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

describe('computeFrame', () => {
  it('держит выделение с запасом и берёт пропорции модели', () => {
    const bbox = { x: 4000, y: 3000, width: 600, height: 400 };
    const { rect, inside, aspectRatio } = computeFrame(bbox, { width: 8000, height: 6000 }, opts);
    expect(contains(rect, { x: bbox.x - 180, y: bbox.y - 180, width: 960, height: 760 })).toBe(true);
    expect(rect).toEqual(inside);
    expect(Math.abs(rect.width / rect.height - parseRatio(aspectRatio))).toBeLessThan(0.01);
  });

  it('у края холста сдвигает рамку внутрь, а не обрезает выделение', () => {
    const bbox = { x: 10, y: 5800, width: 300, height: 190 };
    const { rect, inside } = computeFrame(bbox, { width: 8000, height: 6000 }, opts);
    expect(rect).toEqual(inside);
    expect(contains(rect, bbox)).toBe(true);
  });

  it('на узком холсте достраивает поля, когда пропорции иначе не влезают', () => {
    const canvas = { width: 5000, height: 300 };
    const bbox = { x: 100, y: 0, width: 4800, height: 300 };
    const { rect, inside } = computeFrame(bbox, canvas, opts);
    expect(contains(rect, bbox)).toBe(true);
    expect(inside).toEqual({ x: 0, y: 0, width: 5000, height: 300 });
    expect(rect.height).toBeGreaterThan(300);
  });

  it('минимальный запас контекста — не меньше contextMin', () => {
    const bbox = { x: 3000, y: 3000, width: 20, height: 20 };
    const { rect } = computeFrame(bbox, { width: 8000, height: 6000 }, opts);
    expect(rect.width).toBeGreaterThanOrEqual(20 + 2 * 128);
    expect(rect.height).toBeGreaterThanOrEqual(20 + 2 * 128);
  });
});

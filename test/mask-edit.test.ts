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

  it('мягкая кисть: середина мазка сплошная, к краю кисти он плавно сходит на нет; жёсткая — с резким краем', async () => {
    const rect = { x: 0, y: 0, width: 200, height: 100 };
    const row = async (softness: number, erase = false) => {
      const start = new Uint8Array(rect.width * rect.height).fill(erase ? 255 : 0);
      const mask = await applyShapes(start, rect, [{ kind: 'stroke', points: [[20, 50], [180, 50]], size: 60, softness, erase }]);
      // Поперёк мазка: от середины (y = 50) к краю кисти (y = 80)
      return Array.from({ length: 36 }, (_, d) => mask[(50 + d) * rect.width + 100]!);
    };
    const hard = await row(0);
    expect(hard.slice(0, 29).every((v) => v === 255)).toBe(true);
    expect(hard.slice(31).every((v) => v === 0)).toBe(true);

    const soft = await row(1);
    expect(soft[0]).toBeGreaterThan(240);
    expect(soft[15]).toBeGreaterThan(60);
    expect(soft[15]).toBeLessThan(200);
    expect(soft[30]).toBeLessThan(8);
    for (let d = 1; d < soft.length; d++) expect(soft[d]).toBeLessThanOrEqual(soft[d - 1]!);

    // Мягкий ластик: в середине стирает, у края почти не трогает
    const erased = await row(0.5, true);
    expect(erased[0]).toBe(0);
    expect(erased[29]).toBeGreaterThan(240);
  });

  it('мягкий мазок-точка не обрезается областью фильтра', async () => {
    const rect = { x: 100, y: 100, width: 100, height: 100 };
    const mask = await applyShapes(new Uint8Array(rect.width * rect.height), rect, [
      { kind: 'stroke', points: [[150, 150], [150.1, 150]], size: 40, softness: 0.5 },
    ]);
    const at = (x: number, y: number) => mask[(y - rect.y) * rect.width + (x - rect.x)]!;
    expect(at(150, 150)).toBe(255);
    expect(at(150, 162)).toBeGreaterThan(100);
    expect(at(150, 172)).toBeLessThan(10);
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

  /** Белый кусок в косую линейку (штрих 3 px через 16 px), сдвинутую на shift, — как линейный рисунок */
  function ruled(w: number, h: number, shift: number): Uint8Array {
    const out = new Uint8Array(w * h * 3).fill(255);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + y + shift) % 16 < 3) out.fill(0, (y * w + x) * 3, (y * w + x) * 3 + 3);
    return out;
  }

  it('сдвиг линий на пару пикселей изменением не считается: маска не разливается по перерисованному куску', () => {
    const w = 240;
    const h = 200;
    const original = ruled(w, h, 0);
    // Модель перерисовала весь кусок со сдвигом линий на 2 px и нарисовала круг крупнее выделения
    const generated = ruled(w, h, 2);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - 120, y - 100);
        if (r <= 30) mask[y * w + x] = 255;
        if (r <= 50) generated.fill(r > 46 ? 0 : 255, (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    const { mask: out } = expandMaskByDiff(mask, original, generated, w, h);
    // Круг взят целиком с контуром и запасом, перерисованные линии вдали — нет
    for (let x = 120 - 50; x <= 120 + 50; x++) expect(out[100 * w + x]).toBe(255);
    expect(out[100 * w + 120 + 90]).toBe(0);
    expect(out[22 * w + 200]).toBe(0);
    // Пиксель в пиксель сдвинутые линии — изменение, и маска уходит по ним через весь кусок
    const exact = expandMaskByDiff(mask, original, generated, w, h, { tolerance: 0 });
    expect(exact.mask[22 * w + 200]).toBe(255);
  });

  it('к закрытому краю куска маска вплотную не подходит', () => {
    const w = 100;
    const h = 60;
    const original = new Uint8Array(w * h * 3).fill(100);
    // Модель нарисовала полосу через весь кусок, выделена её середина
    const generated = new Uint8Array(original);
    const mask = new Uint8Array(w * h);
    for (let y = 20; y < 40; y++) {
      for (let x = 0; x < w; x++) {
        generated.fill(230, (y * w + x) * 3, (y * w + x) * 3 + 3);
        if (x >= 40 && x < 60) mask[y * w + x] = 255;
      }
    }
    const open = expandMaskByDiff(mask, original, generated, w, h, { grow: 4 });
    expect(open.mask[30 * w]).toBe(255);
    const closed = expandMaskByDiff(mask, original, generated, w, h, { grow: 4, closed: { left: true, top: true, right: false, bottom: true } });
    expect(closed.mask[30 * w]).toBe(0);
    expect(closed.mask[30 * w + 1]).toBe(255);
    expect(closed.mask[30 * w + w - 1]).toBe(255);
  });
});

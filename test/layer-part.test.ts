// Работа в слое: правка части слоя ложится его версией поверх прежней, слой растёт за выделением, палочка — в границах слоя.
import { describe, expect, it } from 'vitest';
import { CanvasDocument } from '../src/core/document.ts';
import { applyLayer, layerOver, type MaskedLayer } from '../src/core/edit-region.ts';
import { featherAlpha } from '../src/core/mask.ts';
import { clipBitmap, clipScaled, unionBitmap } from '../src/core/objects.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';
import type { MaskShape } from '../src/shared/api.ts';

/** Слой цвета color в рамке rect с маской-кругом и растушёвкой: как версия после генерации */
function round(rect: { x: number; y: number; width: number; height: number }, color: [number, number, number]): MaskedLayer {
  const { width, height } = rect;
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (((x - width / 2) / (width / 2)) ** 2 + ((y - height / 2) / (height / 2)) ** 2 <= 0.8) mask[y * width + x] = 255;
  const alpha = featherAlpha(mask, width, height, 6);
  const layer = Buffer.alloc(width * height * 4);
  // Цвет ответа модели и за маской: его вернёт кисть
  for (let i = 0; i < width * height; i++) layer.set([...color, Math.round(alpha[i]! * 255)], i * 4);
  return { rect, layer, mask };
}

const px = (doc: CanvasDocument, x: number, y: number) => [...doc.composite.subarray((y * doc.width + x) * 3, (y * doc.width + x) * 3 + 3)];

async function until(ok: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > 15_000) throw new Error('Не дождались');
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('Правка части слоя', () => {
  it('новая версия — прежняя с правкой поверх: холст тот же, что с обеими, вне масок — побайтно исходник', () => {
    const W = 200;
    const base = Buffer.alloc(W * W * 3, 90);
    const canvas = { x: 0, y: 0, width: W, height: W };
    const below = round({ x: 20, y: 30, width: 100, height: 90 }, [200, 40, 10]);
    const top = round({ x: 80, y: 60, width: 90, height: 100 }, [10, 60, 220]);

    const both = Buffer.from(base);
    applyLayer({ data: both, rect: canvas, channels: 3 }, below.rect, below.layer);
    applyLayer({ data: both, rect: canvas, channels: 3 }, top.rect, top.layer);
    const over = layerOver(below, top);
    const merged = Buffer.from(base);
    applyLayer({ data: merged, rect: canvas, channels: 3 }, over.rect, over.layer);

    let worst = 0;
    for (let i = 0; i < both.length; i++) worst = Math.max(worst, Math.abs(both[i]! - merged[i]!));
    expect(worst).toBeLessThanOrEqual(1);
    expect(over.rect).toEqual({ x: 20, y: 30, width: 150, height: 130 });
    // Где нет ни одной из масок, слоя не видно: холст побайтно прежний
    for (let i = 0; i < over.mask.length; i++) {
      if (over.mask[i]) continue;
      const x = over.rect.x + (i % over.rect.width);
      const y = over.rect.y + Math.floor(i / over.rect.width);
      expect(merged.subarray((y * W + x) * 3, (y * W + x) * 3 + 3).equals(base.subarray(0, 3))).toBe(true);
    }
    // part — маска одной правки в рамке версии
    const at = (x: number, y: number) => over.part[(y - over.rect.y) * over.rect.width + x - over.rect.x];
    expect(at(125, 110)).toBe(255);
    expect(at(40, 70)).toBe(0);
  });

  it('правка в слое меняет только выделенное, остальной слой — от прежней версии; «Ещё варианты» перерисовывают только её', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(400, 300, [255, 255, 255]);
    const doc = s.doc!;
    const id = await s.saveObject([{ kind: 'rect', x: 100, y: 80, width: 200, height: 140 }]);
    const layer: MaskShape = { kind: 'mask', id: `obj:${id}`, x: 0, y: 0, width: 1, height: 1 };
    s.createJob({ shapes: [layer], object: id, prompt: 'весь', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.at(-1)?.status === 'done');
    const first = doc.object(id).current!;
    const withFirst = Buffer.from(doc.composite);
    const part = { x: 200, y: 120, width: 60, height: 60 };
    /** Вне куска part холст побайтно такой, как с первой версией */
    const restAsFirst = () => {
      for (let y = 0; y < doc.height; y++) {
        for (let x = 0; x < doc.width; x++) {
          if (x >= part.x && y >= part.y && x < part.x + part.width && y < part.y + part.height) continue;
          const i = (y * doc.width + x) * 3;
          if (!doc.composite.subarray(i, i + 3).equals(withFirst.subarray(i, i + 3))) return [x, y];
        }
      }
      return null;
    };

    // Правка части слоя: кусок внутри него
    s.createJob({ shapes: [{ kind: 'rect', ...part }], object: id, prompt: 'часть', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.at(-1)?.status === 'done');
    const second = doc.patch(doc.object(id).current!);
    expect(second.object).toBe(id);
    expect(second.base).toBe(first);
    // Выделенное перерисовано, остальной слой — как в первой версии, вне слоя — исходник
    expect(px(doc, 230, 150)).not.toEqual([...withFirst.subarray((150 * 400 + 230) * 3, (150 * 400 + 230) * 3 + 3)]);
    expect(restAsFirst()).toBeNull();
    // Слой выделение не перерос — его маска прежняя
    expect(doc.object(id).rect).toEqual({ x: 100, y: 80, width: 200, height: 140 });

    // «Ещё варианты» этой версии: кусок — только правка, поверх первой версии
    const withSecond = px(doc, 230, 150);
    const more = s.patchVariants(second.id, { variants: 1, model: 'flash', size: 'auto' });
    expect(s.state().jobs.find((j) => j.id === more)!.bbox).toEqual(part);
    await until(() => s.state().jobs.find((j) => j.id === more)?.status === 'done');
    const third = doc.patch(doc.object(id).current!);
    expect(third.id).not.toBe(second.id);
    expect(third.base).toBe(first);
    expect(px(doc, 230, 150)).not.toEqual(withSecond);
    expect(restAsFirst()).toBeNull();

    // Проект помнит, поверх чего легла правка
    const { doc: back } = await openProject(await encodeProject(doc), 'проект.caaa');
    const again = back.patch(third.id);
    expect(again.base).toBe(first);
    expect(Buffer.from(again.part!).equals(Buffer.from(third.part!))).toBe(true);
    expect(back.composite.equals(doc.composite)).toBe(true);
  }, 20_000);

  it('выделение за краем слоя — слой растёт; без слоя — новый слой', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(400, 300, [255, 255, 255]);
    const doc = s.doc!;
    const id = await s.saveObject([{ kind: 'rect', x: 100, y: 80, width: 100, height: 100 }]);
    s.createJob({ shapes: [{ kind: 'rect', x: 150, y: 80, width: 100, height: 100 }], object: id, prompt: 'хвост', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.at(-1)?.status === 'done');
    expect(doc.object(id).rect).toEqual({ x: 100, y: 80, width: 150, height: 100 });
    expect(doc.objects).toHaveLength(1);

    s.createJob({ shapes: [{ kind: 'rect', x: 300, y: 200, width: 40, height: 40 }], prompt: 'рядом', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.at(-1)?.status === 'done');
    expect(doc.objects).toHaveLength(2);
    expect(doc.objects[1]!.name).toBe('рядом');
  }, 10_000);

  it('в скрытый слой правка не идёт', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(400, 300, [255, 255, 255]);
    const id = await s.saveObject([{ kind: 'rect', x: 100, y: 80, width: 100, height: 100 }]);
    s.createJob({ shapes: [{ kind: 'rect', x: 100, y: 80, width: 10, height: 10 }], object: id, prompt: 'x', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.at(-1)?.status === 'done');
    await s.setHidden(id, true);
    expect(() => s.createJob({ shapes: [{ kind: 'rect', x: 100, y: 80, width: 10, height: 10 }], object: id, prompt: 'x', variants: 1, model: 'flash', size: 'auto' })).toThrow('скрыт');
  });
});

describe('Маски в границах слоя', () => {
  const box = (x: number, y: number, width: number, height: number) => ({ rect: { x, y, width, height }, mask: new Uint8Array(width * height).fill(255) });

  it('обрезка по слою и объединение', () => {
    expect(clipBitmap(box(0, 0, 50, 50), box(30, 20, 50, 50))?.rect).toEqual({ x: 30, y: 20, width: 20, height: 30 });
    expect(clipBitmap(box(0, 0, 10, 10), box(30, 20, 50, 50))).toBeNull();
    const u = unionBitmap(box(0, 0, 10, 10), box(20, 5, 10, 10));
    expect(u.rect).toEqual({ x: 0, y: 0, width: 30, height: 15 });
    expect(u.mask[0]).toBe(255);
    expect(u.mask[14]).toBe(0);
  });

  it('подсветка в масштабе — тоже по слою', () => {
    // Подсветка вдвое меньше холста: её 0..50 — это 0..100 холста; слой — правая половина
    const clipped = clipScaled(box(0, 0, 50, 50), box(50, 0, 50, 100), 0.5);
    expect(clipped?.rect).toEqual({ x: 25, y: 0, width: 25, height: 50 });
  });
});

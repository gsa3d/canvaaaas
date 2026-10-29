// С настоящей моделью SAM: тест идёт, только если её веса уже скачаны (~290 МБ в папке данных приложения)
import { describe, expect, it } from 'vitest';
import { overlap, area } from '../src/core/objects.ts';
import type { Bitmap } from '../src/core/segment.ts';
import { modelInstalled } from '../src/core/segment-model.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';

const W = 800;
const H = 600;

/** Тёмный круг на светлом фоне, а рядом — квадрат: два явных объекта */
function paint(doc: { composite: Buffer; width: number }, r: number): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inDisc = Math.hypot(x - 300, y - 300) <= r;
      const inSquare = x >= 560 && x < 680 && y >= 140 && y < 260;
      const c = inDisc ? [40, 90, 160] : inSquare ? [200, 60, 40] : [235, 232, 225];
      doc.composite.set(c, (y * W + x) * 3);
    }
  }
}

function discMask(r: number): Bitmap {
  const rect = { x: 300 - r, y: 300 - r, width: 2 * r + 1, height: 2 * r + 1 };
  const mask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) if (Math.hypot(x - r, y - r) <= r) mask[y * rect.width + x] = 255;
  return { rect, mask };
}

const iou = (a: Bitmap, b: Bitmap) => {
  const i = overlap(a, b);
  return i / (area(a) + area(b) - i);
};

describe.skipIf(!modelInstalled())('SAM', () => {
  it('щелчок выделяет круг; правка, после которой он вырос, растит и маску объекта, ⌘Z возвращает прежнюю', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, [235, 232, 225]);
    const doc = s.doc!;
    // Исходник — круг радиусом 80: пишем прямо в исходник и холст
    paint({ composite: doc.base, width: W }, 80);
    paint(doc, 80);
    doc.rev++;

    const view = { x: 0, y: 0, width: W, height: H };
    const pick = await s.pickObject({ view, points: [{ x: 300, y: 300, positive: true }] });
    const level = pick.levels[pick.level]!;
    const found = s.segmentation.bitmap(level.id);
    expect(iou(found, discMask(80))).toBeGreaterThan(0.9);

    const id = await s.saveObject([{ kind: 'mask', id: level.id, ...level.rect }]);
    // Правка: круг стал радиусом 110
    const rect = { x: 160, y: 160, width: 280, height: 280 };
    const layer = Buffer.alloc(rect.width * rect.height * 4);
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        const on = Math.hypot(rect.x + x - 300, rect.y + y - 300) <= 110;
        layer.set(on ? [40, 90, 160, 255] : [235, 232, 225, 255], (y * rect.width + x) * 4);
      }
    }
    const before = doc.region(rect);
    const patch = doc.addPatch({ id: 'grow', rect, layer, prompt: 'больше', jobId: 'j', variant: 0, createdAt: '' });
    await (s as unknown as { followObjects: (...a: unknown[]) => Promise<void> }).followObjects(doc, patch.id, rect, before, doc.region(rect));
    expect(iou(doc.object(id), discMask(110))).toBeGreaterThan(0.9);

    await s.undo();
    expect(doc.patches).toHaveLength(0);
    expect(iou(doc.object(id), discMask(80))).toBeGreaterThan(0.9);
  }, 60_000);
});

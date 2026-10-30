// С настоящей моделью SAM: тест идёт, только если её веса уже скачаны (~290 МБ в папке данных приложения)
import { describe, expect, it } from 'vitest';
import { overlap, area } from '../src/core/objects.ts';
import type { Bitmap } from '../src/core/segment.ts';
import { modelInstalled } from '../src/core/segment-model.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';
import { OUTSIDE_LAYER } from '../src/shared/api.ts';

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
  it('щелчок выделяет круг; добавить то, что уже выделено, или вычесть то, чего нет, — выделение не меняется', async () => {
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

    // Добавить к выделению то, что уже в нём, или вычесть то, чего в нём нет, — выделение не изменится
    const disc = [{ kind: 'mask' as const, id: level.id, ...level.rect }];
    const again = await s.pickObject({ view, points: [{ x: 290, y: 310, positive: true }], op: 'add', selection: disc });
    expect(again.unchanged).toBe(true);
    const square = await s.pickObject({ view, points: [{ x: 620, y: 200, positive: true }], op: 'sub', selection: disc });
    expect(square.unchanged).toBe(true);
    const added = await s.pickObject({ view, points: [{ x: 620, y: 200, positive: true }], op: 'add', selection: disc });
    expect(added.unchanged).toBeUndefined();

  }, 60_000);

  it('палочка ищет у хозяина точки: в слое — внутри него, по другому слою — входит в него, по фону — мимо слоёв', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, [235, 232, 225]);
    const doc = s.doc!;
    paint({ composite: doc.base, width: W }, 80);
    paint(doc, 80);
    doc.rev++;
    // Слой — левая половина круга
    const half = await s.saveObject([{ kind: 'rect', x: 200, y: 200, width: 100, height: 200 }]);
    const view = { x: 0, y: 0, width: W, height: H };

    // Вне слоя щелчок по нему — вход в слой, без модели
    const enter = await s.pickObject({ view, points: [{ x: 270, y: 300, positive: true }] });
    expect(enter).toMatchObject({ enter: true, owner: half, levels: [{ id: `obj:${half}` }] });

    // В слое — уровни в его границах
    const inside = await s.pickObject({ view, points: [{ x: 270, y: 300, positive: true }], within: half });
    expect(inside.owner).toBe(half);
    expect(inside.enter).toBeUndefined();
    const right = (id: string) => {
      const b = s.segmentation.bitmap(id);
      return b.rect.x + b.rect.width;
    };
    for (const level of inside.levels) expect(right(level.id)).toBeLessThanOrEqual(302);

    // По фону — круг без слоя: его левой половины в выделении нет
    const outside = await s.pickObject({ view, points: [{ x: 340, y: 300, positive: true }], within: half });
    expect(outside.owner).toBeNull();
    const disc = s.segmentation.bitmap(outside.levels[outside.level]!.id);
    expect(disc.rect.x).toBeGreaterThanOrEqual(298);
    expect(area(disc)).toBeGreaterThan(0.8 * (Math.PI * 80 * 80) / 2);

    // Добавить к выделению слоя то, что на фоне, — нельзя: объекты разных слоёв не смешиваются
    await expect(s.pickObject({ view, points: [{ x: 620, y: 200, positive: true }], within: half, op: 'add', selection: [] })).rejects.toThrow(OUTSIDE_LAYER);
  }, 60_000);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedInside } from '../src/core/expand.ts';
import { featherAlpha } from '../src/core/mask.ts';
import { area, overlap, trim } from '../src/core/objects.ts';
import { Prefs } from '../src/core/prefs.ts';
import type { Bitmap } from '../src/core/segment.ts';
import { modelInstalled } from '../src/core/segment-model.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';

const W = 900;
const H = 700;
const BASE: [number, number, number] = [235, 232, 225];
/** Выделение, по которому модель рисовала: куда шире «дерева» */
const R = { x: 100, y: 100, width: 500, height: 400 };
/** «Дерево» — тёмный круг не в середине выделения */
const TREE = { cx: 280, cy: 300, r: 80 };

const inTree = (x: number, y: number) => Math.hypot(x - TREE.cx, y - TREE.cy) <= TREE.r;

/** Ответ модели на весь кусок: фон почти как был (с шумом, как у перерисовки), а на нём — дерево */
function answer(): Buffer {
  const rgb = Buffer.alloc(R.width * R.height * 3);
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 13) - 6;
  for (let y = 0; y < R.height; y++) {
    for (let x = 0; x < R.width; x++) {
      const c = inTree(R.x + x, R.y + y) ? [40, 110, 50] : BASE.map((v) => v + noise());
      rgb.set(c, (y * R.width + x) * 3);
    }
  }
  return rgb;
}

const iou = (a: Bitmap, b: Bitmap) => {
  const i = overlap(a, b);
  return i / (area(a) + area(b) - i);
};

function treeMask(): Bitmap {
  const rect = { x: TREE.cx - TREE.r, y: TREE.cy - TREE.r, width: 2 * TREE.r + 1, height: 2 * TREE.r + 1 };
  const mask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) if (inTree(rect.x + x, rect.y + y)) mask[y * rect.width + x] = 255;
  return { rect, mask };
}

describe('Что модель поменяла под маской', () => {
  it('рамка — по изменённому, редкий шум по всему куску её не раздувает; без изменений — null', () => {
    const w = 200;
    const h = 100;
    const before = new Uint8Array(w * h * 3).fill(200);
    const after = Uint8Array.from(before);
    const mask = new Uint8Array(w * h).fill(255);
    expect(changedInside(mask, before, after, w, h)).toBeNull();
    for (let y = 30; y < 70; y++) for (let x = 120; x < 170; x++) after.fill(20, (y * w + x) * 3, (y * w + x) * 3 + 3);
    // Две одиночные точки шума в углах
    after.fill(0, 0, 3);
    after.fill(0, (h * w - 1) * 3, h * w * 3);
    const found = changedInside(mask, before, after, w, h)!;
    expect(found.box.x).toBeGreaterThanOrEqual(118);
    expect(found.box.x + found.box.width).toBeLessThanOrEqual(172);
    expect(found.box.y).toBeGreaterThanOrEqual(28);
    expect(found.box.y + found.box.height).toBeLessThanOrEqual(72);
    // Вне маски изменённого нет
    expect(changedInside(new Uint8Array(w * h), before, after, w, h)).toBeNull();
  });
});

describe('Настройки интерфейса', () => {
  it('помнятся после перезапуска; чужое имя и слишком длинное значение — ошибка', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvaaaas-prefs-'));
    try {
      const prefs = await Prefs.load(dir);
      await prefs.set('model', 'pro');
      await prefs.set('variants', 3);
      expect((await Prefs.load(dir)).all()).toEqual({ model: 'pro', variants: 3 });
      expect(() => prefs.set('../x', 1)).toThrow();
      expect(() => prefs.set('style', 'x'.repeat(5000))).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!modelInstalled())('Маска по объекту (SAM)', () => {
  /** Слой «дерево» с версией: ответ модели на весь R, видно его по выделению selected (растушёвка 24) */
  async function setup(selected: Uint8Array) {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, BASE);
    const doc = s.doc!;
    const alpha = featherAlpha(selected, R.width, R.height, 24);
    const rgb = answer();
    const layer = Buffer.alloc(R.width * R.height * 4);
    for (let i = 0; i < alpha.length; i++) {
      rgb.copy(layer, i * 4, i * 3, i * 3 + 3);
      layer[i * 4 + 3] = Math.round(alpha[i]! * 255);
    }
    doc.setObjects([{ id: 'tree', name: 'дерево', rect: R, mask: selected, createdAt: '', version: 1, current: 'a', edit: true }]);
    doc.addPatch({ id: 'a', rect: R, layer, mask: selected, feather: 24, prompt: 'дерево', jobId: 'j', variant: 1, createdAt: '', object: 'tree' });
    return { s, doc };
  }

  it('модель нарисовала дерево шире выделения: маска — всё дерево, а не обрезанное рамкой; за выделением — только дерево', { timeout: 60_000 }, async () => {
    // Выделение кончается посреди дерева: справа от x = TREE.cx + 30
    const right = TREE.cx + 30 - R.x;
    const selected = new Uint8Array(R.width * R.height);
    for (let y = 0; y < R.height; y++) selected.fill(255, y * R.width, y * R.width + right);
    const { s, doc } = await setup(selected);
    await s.objectMask('a', false);
    const p = doc.patch('a');
    expect(iou(trim({ rect: R, mask: p.mask })!, treeMask())).toBeGreaterThan(0.85);
    // За выделением рядом с деревом модель ничего не поменяла — там версии нет
    const i = (TREE.cy - R.y) * R.width + TREE.cx + TREE.r + 30 - R.x;
    expect(p.layer[i * 4 + 3]).toBe(0);
  });

  it('маска версии и слой — по дереву, а не по выделению; вне дерева холст побайтно как под версией; ⌘Z возвращает', { timeout: 60_000 }, async () => {
    const { s, doc } = await setup(new Uint8Array(R.width * R.height).fill(255));
    const withRect = Buffer.from(doc.composite);

    await s.objectMask('a', false);
    const p = doc.patch('a');
    const found = trim({ rect: R, mask: p.mask })!;
    expect(iou(found, treeMask())).toBeGreaterThan(0.85);
    // Слой — тоже дерево: щелчок по нему выделит его, а не прямоугольник
    expect(iou(doc.object('tree'), treeMask())).toBeGreaterThan(0.85);
    // Там, где маска 0, холст — исходник, побайтно
    for (const [x, y] of [
      [R.x + 5, R.y + 5],
      [R.x + R.width - 10, R.y + R.height - 10],
      [TREE.cx + TREE.r + 20, TREE.cy],
    ] as const) {
      const i = (y - R.y) * R.width + x - R.x;
      expect(p.layer[i * 4 + 3]).toBe(0);
      expect([...doc.composite.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]).toEqual([...doc.base.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]);
    }

    await s.undo();
    expect(doc.composite.equals(withRect)).toBe(true);
    expect(doc.object('tree').rect).toEqual(R);
  });
});

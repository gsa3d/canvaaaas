import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featherAlpha } from '../src/core/mask.ts';
import { alignMask, objectMaskRequest } from '../src/core/object-mask.ts';
import { area, overlap, trim } from '../src/core/objects.ts';
import { Prefs } from '../src/core/prefs.ts';
import type { Bitmap } from '../src/core/segment.ts';
import { noKeys } from '../src/core/secrets.ts';
import { mockProvider } from '../src/providers/mock.ts';
import { Session } from '../src/server/session.ts';

const W = 900;
const H = 700;
const BASE: [number, number, number] = [235, 232, 225];
/** Выделение, по которому модель рисовала: куда шире «дерева»; 5:4 — у подставной модели таких пропорций нет */
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

describe('Маска по объекту', () => {
  /** Слой «дерево» с версией: ответ модели на весь R, видно его по выделению selected (растушёвка 24) */
  async function setup(selected: Uint8Array) {
    const s = new Session('mock', noKeys());
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

  it('кусок не в пропорциях модели дополняется серыми полями до ближайших, разрешение — не меньше куска', async () => {
    const rgb = answer();
    const req = await objectMaskRequest(rgb, new Uint8Array(R.width * R.height).fill(255), R.width, R.height, mockProvider());
    expect(req.generate.aspectRatio).toBe('4:3');
    expect(req.frame).toEqual({ width: 533, height: 400 });
    expect(req.at).toEqual({ x: 16, y: 0 });
    expect(req.generate.imageSize).toBe('1K');
    expect(req.generate.images).toHaveLength(2);
    expect(req.generate.prompt).toContain('padding');
  });

  it('маска версии и слой — по дереву, а не по выделению; вне дерева холст побайтно как под версией; ⌘Z возвращает', { timeout: 30_000 }, async () => {
    const { s, doc } = await setup(new Uint8Array(R.width * R.height).fill(255));
    const withRect = Buffer.from(doc.composite);

    await s.objectMask('a', 'flash');
    const p = doc.patch('a');
    expect(iou(trim({ rect: R, mask: p.mask })!, treeMask())).toBeGreaterThan(0.9);
    // Слой — тоже дерево: щелчок по нему выделит его, а не прямоугольник
    expect(iou(doc.object('tree'), treeMask())).toBeGreaterThan(0.9);
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
    expect(s.state().generations.session).toBe(1);

    await s.undo();
    expect(doc.composite.equals(withRect)).toBe(true);
    expect(doc.object('tree').rect).toEqual(R);
  });

  it('модель нарисовала дерево шире выделения: маска — всё дерево', { timeout: 30_000 }, async () => {
    // Выделение кончается посреди дерева: справа от x = TREE.cx + 30
    const right = TREE.cx + 30 - R.x;
    const selected = new Uint8Array(R.width * R.height);
    for (let y = 0; y < R.height; y++) selected.fill(255, y * R.width, y * R.width + right);
    const { s, doc } = await setup(selected);
    await s.objectMask('a', 'chatgpt');
    expect(iou(trim({ rect: R, mask: doc.patch('a').mask })!, treeMask())).toBeGreaterThan(0.9);
  });
});

describe('Маска от модели на рисунке', () => {
  const w = 300;
  const h = 260;
  const C = { x: 150, y: 130 };
  /** Рисунок: светлый фон в тёмных точках, на нём круг с тёмным контуром толщиной 4 до радиуса 72 */
  function drawing(): Uint8Array {
    const rgb = new Uint8Array(w * h * 3);
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - C.x, y - C.y);
        const v = r <= 68 ? 200 : r <= 72 ? 30 : rnd() < 0.02 ? 40 : 230;
        rgb.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    return rgb;
  }
  const disk = (cx: number, cy: number, r: number) => {
    const m = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.hypot(x - cx, y - cy) <= r) m[y * w + x] = 255;
    return m;
  };
  const bitmap = (mask: Uint8Array): Bitmap => ({ rect: { x: 0, y: 0, width: w, height: h }, mask });

  it('сдвинутая на несколько пикселей маска возвращается на рисунок, на месте — остаётся', () => {
    const rgb = drawing();
    const truth = disk(C.x, C.y, 72);
    expect(alignMask(truth, rgb, w, h)).toMatchObject({ dx: 0, dy: 0 });
    const moved = alignMask(disk(C.x + 5, C.y - 3, 72), rgb, w, h);
    expect(Math.abs(moved.dx + 5)).toBeLessThanOrEqual(1);
    expect(Math.abs(moved.dy - 3)).toBeLessThanOrEqual(1);
    expect(iou(bitmap(moved.mask), bitmap(truth))).toBeGreaterThan(0.97);
  });

  it('растянутая маска сдвигом не совмещается — ошибка', () => {
    expect(() => alignMask(disk(C.x, C.y, 80), drawing(), w, h)).toThrow(/растянула|сдвинула/);
  });

  it('маска пышнее рисунка с одного края, в штриховке — не «растянутая»: половины края не уходят на линии рядом', () => {
    // Рисунок тушью: штриховка вокруг и внутри, круг с контуром; модель обвела верх слева пышнее (как волосы бюста).
    // Половина края, искавшая сдвиг в двух осях сразу, находила себе штрихи на ±15 px — и ровная маска была «растянутой»
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - C.x, y - C.y);
        const hatch = (x + 2 * y) % 9 < 2 || (2 * x - y + 900) % 11 < 2;
        const v = r <= 68 ? ((x + y) % 9 < 1 ? 60 : 235) : r <= 72 ? 25 : hatch ? 40 : 240;
        rgb.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const a = Math.atan2(y - C.y, x - C.x);
        const bulge = a < -Math.PI / 2 ? 20 * Math.sin(-2 * a) ** 2 : 0;
        if (Math.hypot(x - C.x, y - C.y) <= 72 + bulge) mask[y * w + x] = 255;
      }
    }
    const res = alignMask(mask, rgb, w, h);
    expect(Math.abs(res.dx)).toBeLessThanOrEqual(1);
    expect(Math.abs(res.dy)).toBeLessThanOrEqual(1);
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

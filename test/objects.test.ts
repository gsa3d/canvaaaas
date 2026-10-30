import { describe, expect, it } from 'vitest';
import { CanvasDocument, type DocObject } from '../src/core/document.ts';
import { applyShapes } from '../src/core/mask-shapes.ts';
import { changedPixels, overlap, placeObject, removeObject, touchedEdge, trim } from '../src/core/objects.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { LOW, cleanLogits, levels, rasterize, type Bitmap, type Candidate } from '../src/core/segment.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';
import type { MaskShape } from '../src/shared/api.ts';

/** Прямоугольная маска объекта */
function box(x: number, y: number, width: number, height: number): Bitmap {
  return { rect: { x, y, width, height }, mask: new Uint8Array(width * height).fill(255) };
}

/** Круглая маска объекта с центром cx, cy */
function disc(cx: number, cy: number, r: number): Bitmap {
  const rect = { x: cx - r, y: cy - r, width: 2 * r + 1, height: 2 * r + 1 };
  const mask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) if (Math.hypot(x - r, y - r) <= r) mask[y * rect.width + x] = 255;
  return { rect, mask };
}

function obj(id: string, b: Bitmap, parent?: string): DocObject {
  return { id, name: id, ...b, parent, createdAt: '', version: 0 };
}

const parents = (list: DocObject[]) => Object.fromEntries(list.map((o) => [o.id, o.parent ?? null]));

describe('Дерево объектов', () => {
  it('объект встаёт частью того, в чём лежит, и забирает себе то, что лежит в нём', () => {
    let list: DocObject[] = [];
    list = placeObject(list, obj('окно', box(120, 120, 60, 40)));
    list = placeObject(list, obj('трамвай', box(100, 100, 400, 150)));
    list = placeObject(list, obj('кролик', box(130, 125, 20, 20)));
    list = placeObject(list, obj('гусь', box(600, 100, 80, 80)));
    expect(parents(list)).toEqual({ окно: 'трамвай', трамвай: null, кролик: 'окно', гусь: null });

    // Удалили окно — кролик становится частью трамвая
    expect(parents(removeObject(list, 'окно'))).toEqual({ трамвай: null, кролик: 'трамвай', гусь: null });
  });

  it('объект из нескольких — их общий родитель: так они объединяются', () => {
    let list: DocObject[] = [];
    list = placeObject(list, obj('левый', box(0, 0, 50, 50)));
    list = placeObject(list, obj('правый', box(60, 0, 50, 50)));
    const both = trim({ rect: { x: 0, y: 0, width: 110, height: 50 }, mask: new Uint8Array(110 * 50) });
    expect(both).toBeNull();
    list = placeObject(list, obj('пара', { rect: { x: 0, y: 0, width: 110, height: 50 }, mask: union([box(0, 0, 50, 50), box(60, 0, 50, 50)], 110, 50) }));
    expect(parents(list)).toEqual({ левый: 'пара', правый: 'пара', пара: null });
  });

  it('пересечение масок считается по пикселям, а не по рамкам', () => {
    expect(overlap(disc(50, 50, 20), box(30, 30, 41, 41))).toBe(overlap(disc(50, 50, 20), disc(50, 50, 20)));
    expect(overlap(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(25);
  });
});

function union(parts: Bitmap[], width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (const p of parts) {
    for (let y = 0; y < p.rect.height; y++) for (let x = 0; x < p.rect.width; x++) if (p.mask[y * p.rect.width + x]) out[(p.rect.y + y) * width + p.rect.x + x] = 255;
  }
  return out;
}

describe('Маска объекта в выделении', () => {
  it('ложится попиксельно и по порядку с остальными фигурами', async () => {
    const goose = disc(60, 60, 30);
    const lookup = (id: string) => {
      if (id !== 'goose') throw new Error('нет');
      return goose;
    };
    const rect = { x: 0, y: 0, width: 160, height: 120 };
    const shapes: MaskShape[] = [
      { kind: 'rect', x: 100, y: 10, width: 40, height: 40 },
      { kind: 'mask', id: 'goose', ...goose.rect },
      { kind: 'rect', x: 50, y: 50, width: 20, height: 20, erase: true },
    ];
    const mask = await applyShapes(new Uint8Array(160 * 120), rect, shapes, lookup);
    const at = (x: number, y: number) => mask[y * 160 + x];
    expect(at(120, 30)).toBe(255);
    expect(at(60, 40)).toBe(255);
    expect(at(60, 60)).toBe(0);
    expect(at(60, 91)).toBe(0);
    // Внутри круга вне ластика — ровно маска объекта
    for (let y = 30; y <= 90; y++) {
      for (let x = 30; x <= 90; x++) {
        if (x >= 50 && x < 70 && y >= 50 && y < 70) continue;
        expect(at(x, y)).toBe(goose.mask[(y - 30) * goose.rect.width + x - 30]);
      }
    }
    // Стирающая маска объекта после прямоугольника вырезает его
    const cut = await applyShapes(new Uint8Array(160 * 120), rect, [{ kind: 'rect', x: 0, y: 0, width: 160, height: 120 }, { kind: 'mask', id: 'goose', ...goose.rect, erase: true }], lookup);
    expect(cut[60 * 160 + 60]).toBe(0);
    expect(cut[5 * 160 + 5]).toBe(255);
  });
});

describe('Маски объектов и отмена', () => {
  it('пересчёт масок после правки отменяется вместе с ней', () => {
    const doc = CanvasDocument.blank(200, 200, [255, 255, 255], 'test');
    doc.setObjects([obj('гусь', disc(100, 100, 40))]);
    const layer = Buffer.alloc(50 * 50 * 4, 200);
    doc.addPatch({ id: 'p', rect: { x: 75, y: 75, width: 50, height: 50 }, layer, prompt: 'бант', jobId: 'j', variant: 0, createdAt: '' });
    const join = doc.historyTop();
    const moved = { ...doc.object('гусь'), ...disc(100, 100, 30), version: doc.nextObjectVersion() };
    doc.setObjects([moved], { join });
    expect(doc.object('гусь').rect.width).toBe(61);

    doc.undo();
    expect(doc.patches).toHaveLength(0);
    expect(doc.object('гусь').rect.width).toBe(81);
    doc.redo();
    expect(doc.patches).toHaveLength(1);
    expect(doc.object('гусь').rect.width).toBe(61);

    // После правки успели сделать что-то ещё — пересчёт ложится отдельным шагом
    doc.togglePatch('p');
    doc.setObjects([{ ...moved, name: 'гусыня' }], { join: doc.patches[0] });
    doc.undo();
    expect(doc.object('гусь').name).toBe('гусь');
    expect(doc.patches[0]!.active).toBe(false);
  });

  it('объекты сохраняются в .caaa и открываются теми же', async () => {
    const doc = CanvasDocument.blank(200, 160, [255, 255, 255], 'test');
    doc.setObjects([obj('трамвай', box(10, 10, 150, 80)), { ...obj('окно', disc(50, 40, 15), 'трамвай'), lost: true }]);
    doc.addPatch({ id: 'p', rect: { x: 30, y: 20, width: 40, height: 40 }, layer: Buffer.alloc(40 * 40 * 4, 255), prompt: 'окно', jobId: 'j', variant: 0, createdAt: '', object: 'окно' });
    const { doc: back } = await openProject(await encodeProject(doc), 'x.caaa');
    expect(back.objects.map((o) => [o.id, o.name, o.parent, o.lost])).toEqual([
      ['трамвай', 'трамвай', undefined, undefined],
      ['окно', 'окно', 'трамвай', true],
    ]);
    expect(Buffer.from(back.object('окно').mask).equals(Buffer.from(doc.object('окно').mask))).toBe(true);
    expect(back.patches[0]!.object).toBe('окно');
    expect(back.objectsKey).toBe(doc.objectsKey);
  });
});

describe('Задела ли правка край объекта', () => {
  const region = { x: 0, y: 0, width: 300, height: 300 };
  const house = box(20, 20, 260, 260);
  const changeAt = (x: number, y: number, w: number, h: number) => {
    const before = Buffer.alloc(300 * 300 * 3, 255);
    const after = Buffer.from(before);
    for (let r = y; r < y + h; r++) after.fill(0, (r * 300 + x) * 3, (r * 300 + x + w) * 3);
    return changedPixels(before, after, 300, 300);
  };

  it('окно глубоко внутри дома — нет, пристройка у стены — да', () => {
    expect(touchedEdge(house, changeAt(120, 120, 40, 40), region)).toBeNull();
    // Край — полоса в 2% размера объекта (5 px) по обе стороны стены на x = 280
    expect(touchedEdge(house, changeAt(270, 100, 25, 40), region)).toEqual({ x: 275, y: 100, width: 10, height: 40 });
  });
});

describe('Маски из логитов сетки', () => {
  /** Логиты: квадрат клеток gx0..gx1 × gy0..gy1 — объект */
  function square(gx0: number, gy0: number, gx1: number, gy1: number, crop = { x: 100, y: 50, width: 512, height: 256 }): Candidate {
    const logits = new Float32Array(LOW * LOW).fill(-5);
    for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) logits[y * LOW + x] = 5;
    return { logits, score: 0.9, crop };
  }

  it('растягиваются на участок холста и обрезаются по объекту', () => {
    const b = rasterize(square(64, 64, 127, 127))!;
    // Клетка — 2×1 пикселя холста; граница — посередине между клетками
    expect(b.rect).toEqual({ x: 100 + 128, y: 50 + 64, width: 128, height: 64 });
    expect(b.mask.every((v) => v === 255)).toBe(true);
    expect(rasterize({ ...square(0, 0, 0, 0), logits: new Float32Array(LOW * LOW).fill(-1) })).toBeNull();
  });

  it('мелкие дыры заделываются, крошки убираются; проём и дыра у края участка остаются', () => {
    const c = square(40, 40, 140, 140);
    const at = (x: number, y: number) => c.logits[y * LOW + x]!;
    const set = (x0: number, y0: number, x1: number, y1: number, v: number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) c.logits[y * LOW + x] = v;
    };
    // «Шахматка» на штриховке
    for (let y = 50; y < 70; y += 2) for (let x = 50; x < 70; x += 2) c.logits[y * LOW + x] = -3;
    // Проём: 30×30 клеток — 9% площади
    set(90, 90, 119, 119, -5);
    // Крошка рядом и кусок поменьше, но не крошка; объект во всю высоту участка с дырой у края
    set(160, 40, 161, 41, 5);
    set(160, 100, 175, 115, 5);
    set(200, 0, 230, 255, 5);
    set(210, 0, 215, 3, -5);
    cleanLogits(c.logits);
    expect(at(50, 50)).toBeGreaterThan(0);
    expect(at(60, 62)).toBeGreaterThan(0);
    expect(at(100, 100)).toBeLessThan(0);
    expect(at(160, 40)).toBeLessThan(0);
    expect(at(165, 105)).toBeGreaterThan(0);
    expect(at(212, 1)).toBeLessThan(0);
  });

  it('уровни идут от мелкого к крупному, почти одинаковые — одним', () => {
    const small = { ...square(100, 100, 110, 110), score: 0.5 };
    const big = { ...square(50, 50, 200, 200), score: 0.95 };
    const same = { ...square(50, 50, 199, 200), score: 0.7 };
    const lv = levels([big, small, same]);
    expect(lv.levels).toEqual([small, big]);
    expect(lv.best).toBe(1);
  });
});

describe('Объекты в сессии', () => {
  async function session() {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(400, 300, [255, 255, 255]);
    return s;
  }

  it('выделение сохраняется объектом, ⌘Z его убирает; объект — несохранённое изменение', async () => {
    const s = await session();
    expect(s.dirty).toBe(false);
    const a = await s.saveObject([{ kind: 'rect', x: 10, y: 10, width: 100, height: 80 }]);
    const b = await s.saveObject([{ kind: 'ellipse', cx: 250, cy: 150, rx: 40, ry: 30 }]);
    expect(s.state().objects.map((o) => o.name)).toEqual(['Слой 1', 'Слой 2']);
    expect(s.doc!.object(a).rect).toEqual({ x: 10, y: 10, width: 100, height: 80 });
    expect(s.dirty).toBe(true);

    // Объект из двух объектов — их родитель
    const pair = await s.saveObject([
      { kind: 'mask', id: `obj:${a}`, x: 0, y: 0, width: 1, height: 1 },
      { kind: 'mask', id: `obj:${b}`, x: 0, y: 0, width: 1, height: 1 },
    ]);
    expect(parents(s.doc!.objects)).toEqual({ [a]: pair, [b]: pair, [pair]: null });

    await s.renameObject(pair, 'пара');
    await s.deleteObject(pair);
    expect(parents(s.doc!.objects)).toEqual({ [a]: null, [b]: null });
    await s.undo();
    await s.undo();
    expect(s.doc!.object(pair).name).toBe('Слой 3');
    await s.undo();
    await s.undo();
    await s.undo();
    expect(s.doc!.objects).toHaveLength(0);
    expect(s.dirty).toBe(false);
  });

  it('правка в слое — с его маской, вариант ложится его версией и сразу виден', async () => {
    const s = await session();
    const goose = await s.saveObject([{ kind: 'ellipse', cx: 200, cy: 150, rx: 60, ry: 40 }]);
    const shape: MaskShape = { kind: 'mask', id: `obj:${goose}`, x: 0, y: 0, width: 1, height: 1 };
    s.createJob({ shapes: [shape], object: goose, prompt: 'убери бант', variants: 1, model: 'flash', size: 'auto' });
    const started = Date.now();
    while (s.state().jobs[0]?.status !== 'done') {
      if (Date.now() - started > 15_000) throw new Error('Не дождались');
      await new Promise((r) => setTimeout(r, 50));
    }
    // Рамка задачи — по маске объекта на сервере, а не по тому, что прислал интерфейс
    expect(s.state().jobs[0]!.bbox).toEqual({ x: 140, y: 110, width: 120, height: 80 });
    expect(s.doc!.patches[0]!.object).toBe(goose);
    expect(s.doc!.object(goose).current).toBe(s.doc!.patches[0]!.id);
    // Вне маски объекта пиксели холста — побайтно исходник
    const p = s.doc!.patches[0]!;
    for (let y = 0; y < p.rect.height; y += 3) {
      for (let x = 0; x < p.rect.width; x += 3) {
        const cx = p.rect.x + x;
        const cy = p.rect.y + y;
        if (((cx + 0.5 - 200) / 60) ** 2 + ((cy + 0.5 - 150) / 40) ** 2 <= 1.05) continue;
        const i = (cy * 400 + cx) * 3;
        expect([...s.doc!.composite.subarray(i, i + 3)]).toEqual([255, 255, 255]);
      }
    }
  });
});

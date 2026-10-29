import { describe, expect, it } from 'vitest';
import { CanvasDocument } from '../src/core/document.ts';
import { dilate } from '../src/core/objects.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';
import type { MaskShape } from '../src/shared/api.ts';

const W = 400;
const H = 300;
const RED = [220, 30, 30];

/** Белый холст с красным квадратом 60×60 в (100, 100) — и в исходнике, и на холсте */
async function session() {
  const s = new Session('mock', envOnlyStore());
  await s.newDocument(W, H, [255, 255, 255]);
  const doc = s.doc!;
  for (const buf of [doc.base, doc.composite]) {
    for (let y = 100; y < 160; y++) for (let x = 100; x < 160; x++) buf.set(RED, (y * W + x) * 3);
  }
  doc.rev++;
  return s;
}

const px = (doc: CanvasDocument, x: number, y: number) => [...doc.composite.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];

async function done(s: Session) {
  const started = Date.now();
  while (s.state().jobs[0]?.status !== 'done') {
    if (Date.now() - started > 15_000) throw new Error('Не дождались');
    if (s.state().jobs[0]?.status === 'error') throw new Error(s.state().jobs[0]!.error);
    await new Promise((r) => setTimeout(r, 30));
  }
  return s.state().jobs[0]!.id;
}

/** Отделённый квадрат: фон под ним и сам он своим слоем */
async function detached() {
  const s = await session();
  const id = await s.saveObject([{ kind: 'rect', x: 100, y: 100, width: 60, height: 60 }]);
  s.detachObject(id, { model: 'flash', size: 'auto', variants: 1 });
  s.accept(await done(s));
  return { s, doc: s.doc!, id, layer: s.doc!.patches[1]! };
}

describe('Слой сдвигается', () => {
  it('холст пересобирается на обоих местах, ⌘Z возвращает, «не сохранено» видит сдвиг', () => {
    const doc = CanvasDocument.blank(64, 64, [255, 255, 255], 'x');
    const layer = Buffer.alloc(8 * 8 * 4);
    for (let i = 0; i < 64; i++) layer.set([0, 0, 0, 255], i * 4);
    doc.addPatch({ id: 'p', rect: { x: 4, y: 4, width: 8, height: 8 }, layer, prompt: '', jobId: 'j', variant: 0, createdAt: '' });
    const key = doc.contentKey;
    const at = (x: number, y: number) => doc.composite[(y * 64 + x) * 3];
    doc.movePatch('p', { x: 40, y: 30, width: 8, height: 8 });
    expect([at(6, 6), at(42, 32)]).toEqual([255, 0]);
    expect(doc.contentKey).not.toBe(key);
    expect(() => doc.movePatch('p', { x: 60, y: 30, width: 8, height: 8 })).toThrow();
    doc.undo();
    expect([at(6, 6), at(42, 32)]).toEqual([0, 255]);
    expect(doc.contentKey).toBe(key);
    doc.redo();
    expect(at(42, 32)).toBe(0);
  });

  it('batch — один шаг отмены', () => {
    const doc = CanvasDocument.blank(32, 32, [255, 255, 255], 'x');
    const layer = Buffer.alloc(4 * 4 * 4, 255);
    doc.batch(() => {
      doc.addPatch({ id: 'a', rect: { x: 0, y: 0, width: 4, height: 4 }, layer, prompt: '', jobId: 'j', variant: 0, createdAt: '' });
      doc.addPatch({ id: 'b', rect: { x: 8, y: 8, width: 4, height: 4 }, layer, prompt: '', jobId: 'j', variant: 0, createdAt: '' });
    });
    doc.undo();
    expect(doc.patches).toHaveLength(0);
    expect(doc.canUndo).toBe(false);
  });

  it('маска раздувается во все стороны и не за край холста', () => {
    const b = dilate({ rect: { x: 1, y: 10, width: 2, height: 2 }, mask: new Uint8Array(4).fill(255) }, 3, { x: 0, y: 0, width: 50, height: 50 });
    expect(b.rect).toEqual({ x: 0, y: 7, width: 6, height: 8 });
    const on = (x: number, y: number) => b.mask[(y - b.rect.y) * b.rect.width + x - b.rect.x];
    expect(on(5, 10)).toBe(255);
    // Угол дальше 3 px по диагонали — уже нет
    expect(on(5, 7)).toBe(0);
  });
});

describe('Отделить объект', () => {
  it('фон — под ним, объект — своим слоем сверху; холст тот же, вокруг — побайтно исходник', async () => {
    const s = await session();
    const before = Buffer.from(s.doc!.composite);
    const id = await s.saveObject([{ kind: 'rect', x: 100, y: 100, width: 60, height: 60 }]);
    s.detachObject(id, { model: 'flash', size: 'auto', variants: 1 });
    expect(() => s.detachObject(id, { model: 'flash', size: 'auto', variants: 1 })).toThrow('уже отделяется');
    const job = await done(s);
    expect(s.state().jobs[0]!.detach).toBe(id);
    expect(s.state().jobs[0]!.hide).toBe(true);
    // Фон — с запасом в 6 px вокруг квадрата
    expect(s.state().jobs[0]!.bbox).toEqual({ x: 94, y: 94, width: 72, height: 72 });
    s.accept(job);
    const doc = s.doc!;
    const [fill, layer] = doc.patches;
    expect(fill!.object).toBe(id);
    expect(fill!.lifted).toBeUndefined();
    expect(layer!).toMatchObject({ lifted: true, object: id, rect: { x: 98, y: 98, width: 64, height: 64 } });
    expect(doc.object(id).rect).toEqual(layer!.rect);
    expect(s.state().objects[0]!.layer).toBe(layer!.id);
    expect(px(doc, 130, 130)).toEqual(RED);
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (x >= 94 && x < 166 && y >= 94 && y < 166) continue;
        expect(doc.composite[(y * W + x) * 3]).toBe(before[(y * W + x) * 3]);
      }
    }
    // Одним шагом: ⌘Z — ни фона, ни слоя, маска объекта прежняя
    await s.undo();
    expect(doc.patches).toHaveLength(0);
    expect(doc.object(id).rect).toEqual({ x: 100, y: 100, width: 60, height: 60 });
    expect(px(doc, 130, 130)).toEqual(RED);
    expect(() => s.patchVariants(layer!.id, { variants: 1, model: 'flash', size: 'auto' })).toThrow();
  });

  it('сдвиг: объект на новом месте, на старом — фон; части едут с ним; ⌘Z возвращает всё', async () => {
    const { s, doc, id, layer } = await detached();
    const part = await s.saveObject([{ kind: 'rect', x: 110, y: 110, width: 10, height: 10 }]);
    expect(doc.object(part).parent).toBe(id);
    const fillAt = [...doc.regionWithout({ x: 130, y: 130, width: 1, height: 1 }, layer.id)];
    await s.moveObject(id, 100, 50.4);
    expect(layer.rect).toMatchObject({ x: 198, y: 148 });
    expect(px(doc, 230, 180)).toEqual(RED);
    expect(px(doc, 130, 130)).toEqual(fillAt);
    expect(doc.object(id).rect).toEqual(layer.rect);
    expect(doc.object(part).rect).toEqual({ x: 210, y: 160, width: 10, height: 10 });
    expect(s.dirty).toBe(true);
    // Не за край холста
    await s.moveObject(id, 1000, 0);
    expect(layer.rect.x).toBe(W - layer.rect.width);
    await s.undo();
    await s.undo();
    expect(layer.rect).toMatchObject({ x: 98, y: 98 });
    expect(px(doc, 130, 130)).toEqual(RED);
    expect(doc.object(part).rect.x).toBe(110);
  });

  it('ластик по слою стирает и маску объекта; удалить объект — уйти с холста вместе со слоем и частями', async () => {
    const { s, doc, id, layer } = await detached();
    const fillAt = [...doc.regionWithout({ x: 105, y: 130, width: 1, height: 1 }, layer.id)];
    const fillMid = [...doc.regionWithout({ x: 130, y: 130, width: 1, height: 1 }, layer.id)];
    const erase: MaskShape = { kind: 'rect', x: 90, y: 90, width: 40, height: 80, erase: true };
    await s.editPatchMask(layer.id, [erase]);
    expect(px(doc, 105, 130)).toEqual(fillAt);
    expect(doc.object(id).rect).toMatchObject({ x: 130, width: 32 });
    await s.undo();
    expect(doc.object(id).rect.x).toBe(98);
    expect(px(doc, 105, 130)).toEqual(RED);

    await s.saveObject([{ kind: 'rect', x: 110, y: 110, width: 10, height: 10 }]);
    await s.deleteObject(id);
    expect(doc.patches).toHaveLength(1);
    expect(doc.objects).toHaveLength(0);
    expect(px(doc, 130, 130)).toEqual(fillMid);
    await s.undo();
    expect(doc.patches).toHaveLength(2);
    expect(doc.objects).toHaveLength(2);
    // Удалить слой объекта — то же самое
    await s.removePatch(layer.id);
    expect(doc.objects).toHaveLength(0);
  });

  it('правка отделённого объекта ложится в его слой и едет вместе с ним', async () => {
    const { s, doc, id, layer } = await detached();
    const shape: MaskShape = { kind: 'mask', id: `obj:${id}`, x: 0, y: 0, width: 1, height: 1 };
    s.createJob({ shapes: [shape], prompt: 'перекрасить', variants: 1, model: 'flash', size: 'auto' });
    const job = await done(s);
    // Пока выбирали вариант, объект сдвинули
    await s.moveObject(id, 100, 0);
    s.accept(job);
    expect(doc.patches).toHaveLength(2);
    const merged = doc.patches[1]!;
    expect(merged).toMatchObject({ lifted: true, object: id, rect: { x: 198, y: 98 } });
    expect(merged.id).not.toBe(layer.id);
    // Правка — на новом месте объекта, на старом её нет
    const edited = px(doc, 230, 130);
    expect(edited).not.toEqual(RED);
    expect(px(doc, 130, 130)).not.toEqual(edited);
    await s.moveObject(id, -100, 0);
    expect(px(doc, 130, 130)).toEqual(edited);
  });

  it('проект .caaa помнит отделённый объект', async () => {
    const { s, doc, id } = await detached();
    await s.moveObject(id, 40, 0);
    const back = (await openProject(await encodeProject(doc), 'x.caaa')).doc;
    expect(back.patches[1]).toMatchObject({ lifted: true, object: id, rect: doc.patches[1]!.rect });
    expect(back.composite.equals(doc.composite)).toBe(true);
  });
});

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

/** Квадрат-слой с дорисованным фоном: под ним заплатка фона, сам он — своя копия квадрата */
async function detached() {
  const s = await session();
  const id = await s.saveObject([{ kind: 'rect', x: 100, y: 100, width: 60, height: 60 }]);
  s.detachObject(id, { model: 'flash', size: 'auto', variants: 1 });
  await done(s);
  const doc = s.doc!;
  return { s, doc, id, layer: doc.patches.find((p) => p.lifted)!, fill: doc.objects.find((o) => o.kind === 'fill')! };
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

describe('Дорисовать фон под слоем', () => {
  it('⌘J — копия того, что видно, холст тот же; фон под слоем — заплаткой прямо под ним, вокруг — побайтно исходник', async () => {
    const s = await session();
    const before = Buffer.from(s.doc!.composite);
    const id = await s.saveObject([{ kind: 'rect', x: 100, y: 100, width: 60, height: 60 }]);
    const doc = s.doc!;
    // Своя копия с контуром: маска на 2 px шире выделения; на холсте ничего не меняется
    const lifted = doc.patches.find((p) => p.lifted)!;
    expect(lifted).toMatchObject({ object: id, rect: { x: 98, y: 98, width: 64, height: 64 } });
    expect(doc.object(id).rect).toEqual(lifted.rect);
    expect(doc.composite.equals(before)).toBe(true);

    s.detachObject(id, { model: 'flash', size: 'auto', variants: 1 });
    expect(() => s.detachObject(id, { model: 'flash', size: 'auto', variants: 1 })).toThrow('уже рисуется');
    await done(s);
    expect(s.state().jobs[0]).toMatchObject({ detach: id, hide: true, bbox: { x: 92, y: 92, width: 76, height: 76 } });
    // Копию второй раз не снимают
    expect(doc.patches.filter((p) => p.lifted)).toHaveLength(1);
    const fill = doc.objects.find((o) => o.kind === 'fill')!;
    expect(fill).toMatchObject({ under: id, name: 'Фон под «Слой 1»' });
    expect(doc.patch(fill.current!).object).toBe(fill.id);
    expect(s.state().objects.find((o) => o.id === id)).toMatchObject({ layer: lifted.id, filled: true });
    expect(px(doc, 130, 130)).toEqual(RED);
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if (x >= 92 && x < 168 && y >= 92 && y < 168) continue;
        expect(doc.composite[(y * W + x) * 3]).toBe(before[(y * W + x) * 3]);
      }
    }
    // Скрыть слой — под ним заплатка, а не квадрат
    await s.setHidden(id, true);
    expect(px(doc, 130, 130)).not.toEqual(RED);
    await s.setHidden(id, false);
    await s.undo();
    await s.undo();
    await s.undo();
    // Фона нет, копия осталась; ещё шаг — нет и слоя
    expect(doc.patches.map((p) => p.id)).toEqual([lifted.id]);
    expect(doc.objects.map((o) => o.id)).toEqual([id]);
    expect(px(doc, 130, 130)).toEqual(RED);
    expect(() => s.patchVariants(lifted.id, { variants: 1, model: 'flash', size: 'auto' })).toThrow();
    await s.undo();
    expect(doc.patches).toHaveLength(0);
    expect(doc.objects).toHaveLength(0);
  });

  it('сдвиг: слой на новом месте, на старом — заплатка; копия без фона тоже едет, пустой слой — нет; ⌘Z возвращает всё', async () => {
    const { s, doc, id, layer } = await detached();
    const fillAt = [...doc.regionWithout({ x: 130, y: 130, width: 1, height: 1 }, layer.id)];
    await s.moveObject(id, 100, 50.4);
    expect(layer.rect).toMatchObject({ x: 198, y: 148 });
    expect(px(doc, 230, 180)).toEqual(RED);
    expect(px(doc, 130, 130)).toEqual(fillAt);
    expect(doc.object(id).rect).toEqual(layer.rect);
    expect(s.dirty).toBe(true);
    await s.moveObject(id, 1000, 0);
    expect(layer.rect.x).toBe(W - layer.rect.width);
    await s.undo();
    await s.undo();
    expect(layer.rect).toMatchObject({ x: 98, y: 98 });
    expect(px(doc, 130, 130)).toEqual(RED);

    // Копия без фона сдвигается, как в Photoshop: на старом месте — то, что было под ней
    const copy = await s.saveObject([{ kind: 'rect', x: 300, y: 200, width: 20, height: 20 }]);
    await s.moveObject(copy, -10, 0);
    expect(doc.object(copy).rect.x).toBe(288);
    // Слой без своих пикселей (из старого проекта) сдвинуть нечем
    doc.setObjects([...doc.objects, { id: 'empty', name: 'пустой', rect: { x: 10, y: 10, width: 5, height: 5 }, mask: new Uint8Array(25).fill(255), createdAt: '', version: 1 }]);
    await expect(s.moveObject('empty', 5, 5)).rejects.toThrow('нечего сдвигать');
  });

  it('ластик по исходнику стирает и маску слоя; удалить слой — уйти с холста, заплатка и другие слои остаются', async () => {
    const { s, doc, id, layer, fill } = await detached();
    const fillAt = [...doc.regionWithout({ x: 105, y: 130, width: 1, height: 1 }, layer.id)];
    const fillMid = [...doc.regionWithout({ x: 130, y: 130, width: 1, height: 1 }, layer.id)];
    const erase: MaskShape = { kind: 'rect', x: 90, y: 90, width: 40, height: 80, erase: true };
    await s.editPatchMask(layer.id, [erase]);
    expect(px(doc, 105, 130)).toEqual(fillAt);
    expect(doc.object(id).rect).toMatchObject({ x: 130, width: 32 });
    await s.undo();
    expect(doc.object(id).rect.x).toBe(98);
    expect(px(doc, 105, 130)).toEqual(RED);

    const small = await s.saveObject([{ kind: 'rect', x: 110, y: 110, width: 10, height: 10 }]);
    expect(doc.object(small).parent).toBeUndefined();
    await s.deleteObject(id);
    expect(doc.patches.map((p) => p.object)).toEqual([fill.id, small]);
    expect(doc.objects.map((o) => o.id)).toEqual([fill.id, small]);
    expect(px(doc, 130, 130)).toEqual(fillMid);
    await s.undo();
    expect(doc.patches).toHaveLength(3);
    expect(doc.objects).toHaveLength(3);
    await expect(s.removePatch(layer.id)).rejects.toThrow('Исходник');
  });

  it('правка отделённого слоя — его версия: вместо исходника на холсте и едет вместе с ним', async () => {
    const { s, doc, id } = await detached();
    const shape: MaskShape = { kind: 'mask', id: `obj:${id}`, x: 0, y: 0, width: 1, height: 1 };
    s.createJob({ shapes: [shape], object: id, prompt: 'перекрасить', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.at(-1)?.status === 'done');
    const version = doc.object(id).current!;
    expect(doc.patch(version).object).toBe(id);
    const edited = px(doc, 130, 130);
    expect(edited).not.toEqual(RED);
    await s.moveObject(id, 100, 0);
    expect(px(doc, 230, 130)).toEqual(edited);
    expect(px(doc, 130, 130)).not.toEqual(edited);
    // Исходник — снова квадрат на новом месте
    await s.setCurrent(id, null);
    expect(px(doc, 230, 130)).toEqual(RED);
  }, 20_000);

  it('заплатка — прямо под своим слоем: старая правка с тем же предметом не проступает ни после сдвига, ни после удаления', async () => {
    const s = await session();
    const doc = s.doc!;
    // Старая правка — слой из генерации, в её пикселях тот же квадрат, только синий
    const blue = Buffer.alloc(80 * 80 * 4);
    for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) blue.set(x >= 10 && x < 70 && y >= 10 && y < 70 ? [30, 30, 220, 255] : [255, 255, 255, 255], (y * 80 + x) * 4);
    doc.setObjects([{ id: 'old', name: 'старая правка', rect: { x: 90, y: 90, width: 80, height: 80 }, mask: new Uint8Array(6400).fill(255), createdAt: '', version: 1, current: 'v', edit: true }]);
    doc.addPatch({ id: 'v', rect: { x: 90, y: 90, width: 80, height: 80 }, layer: blue, prompt: 'синий', jobId: 'j', variant: 0, createdAt: '', object: 'old' });
    expect(px(doc, 130, 130)).toEqual([30, 30, 220]);
    const id = await s.saveObject([{ kind: 'rect', x: 100, y: 100, width: 60, height: 60 }]);
    expect(doc.object(id).parent).toBeUndefined();
    s.detachObject(id, { model: 'flash', size: 'auto', variants: 1 });
    await done(s);
    const under = px(doc, 130, 130);
    expect(under).toEqual([30, 30, 220]);
    await s.moveObject(id, 200, 0);
    expect(px(doc, 330, 130)).toEqual([30, 30, 220]);
    const fill = [...doc.regionWithout({ x: 130, y: 130, width: 1, height: 1 }, 'v')];
    expect(px(doc, 130, 130)).not.toEqual([30, 30, 220]);
    expect(px(doc, 130, 130)).toEqual(fill);
    await s.deleteObject(id);
    expect(px(doc, 130, 130)).toEqual(fill);
  });

  it('проект .caaa помнит слой с дорисованным фоном', async () => {
    const { s, doc, id } = await detached();
    await s.moveObject(id, 40, 0);
    const back = (await openProject(await encodeProject(doc), 'x.caaa')).doc;
    expect(back.patches.find((p) => p.lifted)).toMatchObject({ object: id, rect: doc.patches.find((p) => p.lifted)!.rect });
    expect(back.objects.find((o) => o.kind === 'fill')).toMatchObject({ under: id });
    expect(back.composite.equals(doc.composite)).toBe(true);
  });
});

async function until(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 15_000) throw new Error('Не дождались');
    await new Promise((r) => setTimeout(r, 30));
  }
}

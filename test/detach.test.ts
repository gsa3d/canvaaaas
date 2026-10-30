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

/** Все задачи готовы */
async function done(s: Session) {
  const started = Date.now();
  while (!s.state().jobs.length || s.state().jobs.some((j) => j.status !== 'done')) {
    if (Date.now() - started > 15_000) throw new Error('Не дождались');
    const failed = s.state().jobs.find((j) => j.status === 'error');
    if (failed) throw new Error(failed.error);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** Слой с одной видимой версией: прямоугольник цвета color */
function addLayer(doc: CanvasDocument, id: string, rect: { x: number; y: number; width: number; height: number }, color: number[]) {
  const layer = Buffer.alloc(rect.width * rect.height * 4);
  for (let i = 0; i < rect.width * rect.height; i++) layer.set([...color, 255], i * 4);
  doc.setObjects([...doc.objects, { id, name: id, rect, mask: new Uint8Array(rect.width * rect.height).fill(255), createdAt: '', version: 1, current: `${id}-v` }]);
  doc.addPatch({ id: `${id}-v`, rect, layer, prompt: id, jobId: id, variant: 0, createdAt: '', object: id });
}

const BLUE = [30, 30, 220];
const WHITE = [255, 255, 255];
const SQUARE = { kind: 'rect' as const, x: 100, y: 100, width: 60, height: 60 };
const FILL = { model: 'flash' as const, size: 'auto' as const, variants: 1 };

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

describe('Вырезать в слой', () => {
  it('из фона: копия сверху, в фоне — белая дыра; картинка та же; скрыть — пусто; одним шагом ⌘Z', async () => {
    const s = await session();
    const doc = s.doc!;
    const before = Buffer.from(doc.composite);
    const base = Buffer.from(doc.base);
    const id = await s.cutObject([SQUARE]);
    expect(doc.composite.equals(before)).toBe(true);
    expect(doc.object(id).freed).toBe(true);
    expect([...doc.base.subarray((130 * W + 130) * 3, (130 * W + 130) * 3 + 3)]).toEqual(WHITE);
    expect(s.state().jobs).toHaveLength(0);
    await s.setHidden(id, true);
    expect(px(doc, 130, 130)).toEqual(WHITE);
    await s.setHidden(id, false);
    await s.undo();
    await s.undo();
    await s.undo();
    expect(doc.objects).toHaveLength(0);
    expect(doc.patches).toHaveLength(0);
    expect(doc.base.equals(base)).toBe(true);
    expect(doc.composite.equals(before)).toBe(true);
  });

  it('из слоя: дыра — в его версии, область слоя прежняя; сквозь неё видно то, что под ним', async () => {
    const s = await session();
    const doc = s.doc!;
    addLayer(doc, 'плитка', { x: 50, y: 50, width: 250, height: 200 }, BLUE);
    const before = Buffer.from(doc.composite);
    const id = await s.cutObject([{ kind: 'rect', x: 120, y: 110, width: 40, height: 40 }]);
    expect(doc.composite.equals(before)).toBe(true);
    expect(doc.object('плитка').rect).toEqual({ x: 50, y: 50, width: 250, height: 200 });
    await s.setHidden(id, true);
    // Под «плиткой» в исходнике — красный квадрат
    expect(px(doc, 140, 130)).toEqual(RED);
    expect(px(doc, 100, 70)).toEqual(BLUE);
  });
});

describe('Дорисовать фон под слоем', () => {
  it('в слое с дырой — его версией; шире слоя на растушёвку: контур не просвечивает', async () => {
    const s = await session();
    const doc = s.doc!;
    addLayer(doc, 'плитка', { x: 20, y: 20, width: 360, height: 260 }, BLUE);
    const id = await s.cutObject([{ kind: 'rect', x: 120, y: 110, width: 40, height: 40 }]);
    const ids = s.fillUnder(id, FILL);
    expect(ids).toHaveLength(1);
    expect(s.state().jobs[0]).toMatchObject({ object: 'плитка', fillFor: id, hide: true });
    expect(() => s.fillUnder(id, FILL)).toThrow('уже рисуется');
    await done(s);
    const version = doc.patch(doc.object('плитка').current!);
    expect(version.object).toBe('плитка');
    // На контуре вырезанного дорисованное лежит целиком
    const alpha = (x: number, y: number) => version.layer[((y - version.rect.y) * version.rect.width + x - version.rect.x) * 4 + 3];
    for (const [x, y] of [[120, 110], [159, 149], [140, 110], [120, 130]] as const) expect(alpha(x, y)).toBe(255);
    await s.setHidden(id, true);
    expect(px(doc, 140, 130)).not.toEqual(RED);
    expect(doc.objects.map((o) => o.id)).toEqual(['плитка', id]);
  });

  it('под слоем только фон — новым слоем в самом низу', async () => {
    const s = await session();
    const doc = s.doc!;
    addLayer(doc, 'небо', { x: 300, y: 10, width: 80, height: 40 }, BLUE);
    const id = await s.cutObject([SQUARE]);
    s.fillUnder(id, FILL);
    expect(s.state().jobs[0]!.object).toBeUndefined();
    await done(s);
    expect(doc.objects.map((o) => o.name)).toEqual(['Фон под «Слой 2»', 'небо', 'Слой 2']);
    await s.setHidden(id, true);
    expect(px(doc, 130, 130)).not.toEqual(WHITE);
    expect(px(doc, 130, 130)).not.toEqual(RED);
  });

  it('под слоем два слоя — по генерации на каждый, по тому, что он в каждом накрывает', async () => {
    const s = await session();
    const doc = s.doc!;
    addLayer(doc, 'левый', { x: 0, y: 0, width: 130, height: 300 }, BLUE);
    addLayer(doc, 'правый', { x: 130, y: 0, width: 270, height: 300 }, [30, 200, 30]);
    const id = await s.saveObject([SQUARE]);
    expect(s.fillUnder(id, FILL)).toHaveLength(2);
    expect(s.state().jobs.map((j) => j.object).sort()).toEqual(['левый', 'правый']);
    await done(s);
    expect(doc.object('левый').current).not.toBe('левый-v');
    expect(doc.object('правый').current).not.toBe('правый-v');
    expect(doc.object(id).freed).toBe(true);
  });
});

describe('Слой с дырой под ним', () => {
  it('сдвиг: на старом месте — пусто, после «Дорисовать фон» — фон; копия без дыры тоже едет, пустой слой — нет; ⌘Z возвращает', async () => {
    const s = await session();
    const doc = s.doc!;
    const id = await s.cutObject([SQUARE]);
    const layer = doc.patches.find((p) => p.lifted)!;
    await s.moveObject(id, 100, 50.4);
    expect(layer.rect).toMatchObject({ x: 198, y: 148 });
    expect(px(doc, 230, 180)).toEqual(RED);
    expect(px(doc, 130, 130)).toEqual(WHITE);
    expect(doc.object(id).rect).toEqual(layer.rect);
    await s.moveObject(id, 1000, 0);
    expect(layer.rect.x).toBe(W - layer.rect.width);
    await s.undo();
    await s.undo();
    expect(layer.rect).toMatchObject({ x: 98, y: 98 });
    expect(px(doc, 130, 130)).toEqual(RED);

    // Копия без дыры сдвигается, как в Photoshop: на старом месте — то, что было под ней
    const copy = await s.saveObject([{ kind: 'rect', x: 300, y: 200, width: 20, height: 20 }]);
    await s.moveObject(copy, -10, 0);
    expect(doc.object(copy).rect.x).toBe(288);
    // Слой без своих пикселей (из старого проекта) сдвинуть нечем
    doc.setObjects([...doc.objects, { id: 'empty', name: 'пустой', rect: { x: 10, y: 10, width: 5, height: 5 }, mask: new Uint8Array(25).fill(255), createdAt: '', version: 1 }]);
    await expect(s.moveObject('empty', 5, 5)).rejects.toThrow('нечего сдвигать');
  });

  it('ластик по исходнику стирает и маску слоя; удалить слой — уйти с холста, другие слои остаются', async () => {
    const s = await session();
    const doc = s.doc!;
    const id = await s.cutObject([SQUARE]);
    const layer = doc.patches.find((p) => p.lifted)!;
    const erase: MaskShape = { kind: 'rect', x: 90, y: 90, width: 40, height: 80, erase: true };
    await s.editPatchMask(layer.id, [erase]);
    expect(px(doc, 105, 130)).toEqual(WHITE);
    expect(doc.object(id).rect).toMatchObject({ x: 130, width: 32 });
    await s.undo();
    expect(doc.object(id).rect.x).toBe(98);
    expect(px(doc, 105, 130)).toEqual(RED);

    const small = await s.saveObject([{ kind: 'rect', x: 300, y: 200, width: 10, height: 10 }]);
    await s.deleteObject(id);
    expect(doc.objects.map((o) => o.id)).toEqual([small]);
    expect(px(doc, 130, 130)).toEqual(WHITE);
    await s.undo();
    expect(doc.objects).toHaveLength(2);
    await expect(s.removePatch(layer.id)).rejects.toThrow('Исходник');
  });

  it('правка вырезанного слоя — его версия: вместо исходника на холсте и едет вместе с ним', async () => {
    const s = await session();
    const doc = s.doc!;
    const id = await s.cutObject([SQUARE]);
    const shape: MaskShape = { kind: 'mask', id: `obj:${id}`, x: 0, y: 0, width: 1, height: 1 };
    s.createJob({ shapes: [shape], object: id, prompt: 'перекрасить', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.at(-1)?.status === 'done');
    const version = doc.object(id).current!;
    expect(doc.patch(version).object).toBe(id);
    const edited = px(doc, 130, 130);
    expect(edited).not.toEqual(RED);
    await s.moveObject(id, 100, 0);
    expect(px(doc, 230, 130)).toEqual(edited);
    expect(px(doc, 130, 130)).toEqual(WHITE);
    // Исходник — снова квадрат на новом месте
    await s.setCurrent(id, null);
    expect(px(doc, 230, 130)).toEqual(RED);
  }, 20_000);

  it('вырезали из старой правки — под ней проступает исходник; «Дорисовать фон» закрашивает дыру в ней же', async () => {
    const s = await session();
    const doc = s.doc!;
    // Старая правка — слой из генерации, в её пикселях тот же квадрат, только синий
    addLayer(doc, 'old', { x: 90, y: 90, width: 80, height: 80 }, BLUE);
    expect(px(doc, 130, 130)).toEqual(BLUE);
    const id = await s.cutObject([SQUARE]);
    await s.moveObject(id, 200, 0);
    expect(px(doc, 330, 130)).toEqual(BLUE);
    expect(px(doc, 130, 130)).toEqual(RED);
    s.fillUnder(id, FILL);
    expect(s.state().jobs[0]!.object).toBe('old');
    await done(s);
    expect(px(doc, 130, 130)).not.toEqual(RED);
    expect(px(doc, 130, 130)).not.toEqual(BLUE);
  });

  it('проект .caaa помнит вырезанный слой и дыру', async () => {
    const s = await session();
    const doc = s.doc!;
    const id = await s.cutObject([SQUARE]);
    await s.moveObject(id, 40, 0);
    const back = (await openProject(await encodeProject(doc), 'x.caaa')).doc;
    expect(back.object(id).freed).toBe(true);
    // Дыра на старом месте: слой уехал, а она — нет
    expect(back.object(id).hole?.rect).toEqual({ x: 100, y: 100, width: 60, height: 60 });
    expect(Buffer.from(back.object(id).hole!.mask).equals(Buffer.from(doc.object(id).hole!.mask))).toBe(true);
    expect(back.patches.find((p) => p.lifted)).toMatchObject({ object: id, rect: doc.patches.find((p) => p.lifted)!.rect });
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

// Группы слоёв, как папки в Photoshop: слои группы лежат в стопке подряд, группа скрывает всё, что в ней, едет целиком,
// разгруппировывается, уходит, когда в ней не осталось слоёв; всё — шагами ⌘Z и в проекте .caaa.
import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '../src/core/document.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';

const W = 300;
const H = 240;
const BG = [250, 250, 250];
const RED = [220, 30, 30];
const BLUE = [30, 30, 220];
const GREEN = [30, 200, 30];

function addLayer(doc: CanvasDocument, id: string, x: number, y: number, size: number, color: number[]) {
  const layer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) layer.set([...color, 255], i * 4);
  const rect = { x, y, width: size, height: size };
  doc.setObjects([...doc.objects, { id, name: id, rect, mask: new Uint8Array(size * size).fill(255), createdAt: '', version: 1, current: `${id}-v` }]);
  doc.addPatch({ id: `${id}-v`, rect, layer, prompt: id, jobId: id, variant: 0, createdAt: '', object: id });
}

const px = (doc: CanvasDocument, x: number, y: number) => [...doc.composite.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
/** Стопка снизу вверх: слой@группа */
const stack = (doc: CanvasDocument) => doc.objects.map((o) => (o.group ? `${o.id}@${doc.group(o.group).name}` : o.id));

/** Красный и синий квадраты перекрываются в (110, 110), зелёный — отдельно */
async function setup() {
  const s = new Session('mock', envOnlyStore());
  await s.newDocument(W, H, BG as [number, number, number]);
  const doc = s.doc!;
  addLayer(doc, 'a', 40, 40, 100, RED);
  addLayer(doc, 'b', 90, 90, 100, BLUE);
  addLayer(doc, 'c', 220, 20, 50, GREEN);
  return { s, doc };
}

describe('Группы слоёв', () => {
  it('группа встаёт на место верхнего, слои в ней — в прежнем порядке; скрытая группа скрывает всё в ней; ⌘Z', async () => {
    const { s, doc } = await setup();
    const before = Buffer.from(doc.composite);
    // c выше b: группа a и c встаёт на место c, b теперь под ними
    const g = await s.groupLayers(['c', 'a'], 'Небо');
    expect(stack(doc)).toEqual(['b', 'a@Небо', 'c@Небо']);
    expect(px(doc, 110, 110)).toEqual(RED);
    expect(s.state().groups).toEqual([{ id: g, name: 'Небо', hidden: undefined, group: undefined }]);

    await s.setGroupHidden(g, true);
    expect(px(doc, 50, 50)).toEqual(BG);
    expect(px(doc, 230, 30)).toEqual(BG);
    expect(px(doc, 110, 110)).toEqual(BLUE);
    expect(s.state().objects.find((o) => o.id === 'a')!.visible).toBe(false);
    await expect(s.mergeIntoBase('a')).rejects.toThrow('скрыт');

    await s.undo();
    await s.undo();
    expect(doc.groups).toEqual([]);
    expect(stack(doc)).toEqual(['a', 'b', 'c']);
    expect(doc.composite.equals(before)).toBe(true);
  });

  it('слой — в группу и из неё; группа едет со всем, что в ней; в саму себя — нельзя', async () => {
    const { s, doc } = await setup();
    const g = await s.groupLayers(['a'], 'Г');
    expect(stack(doc)).toEqual(['a@Г', 'b', 'c']);
    // c — в группу, под a
    await s.moveLayer('c', g, null);
    expect(stack(doc)).toEqual(['c@Г', 'a@Г', 'b']);
    // Группа — над b: красный над синим
    await s.moveLayer(g, null, null);
    expect(stack(doc)).toEqual(['c@Г', 'a@Г', 'b']);
    expect(px(doc, 110, 110)).toEqual(BLUE);
    await s.moveLayer('b', null, g);
    expect(stack(doc)).toEqual(['c@Г', 'a@Г', 'b']);
    await s.moveLayer(g, null, 'b');
    expect(stack(doc)).toEqual(['b', 'c@Г', 'a@Г']);
    expect(px(doc, 110, 110)).toEqual(RED);
    // a — из группы, в самый низ
    await s.moveLayer('a', null, null);
    expect(stack(doc)).toEqual(['a', 'b', 'c@Г']);
    // Последний слой ушёл из группы — её больше нет
    await s.moveLayer('c', null, 'a');
    expect(stack(doc)).toEqual(['a', 'c', 'b']);
    expect(doc.groups).toEqual([]);
    await s.undo();
    expect(stack(doc)).toEqual(['a', 'b', 'c@Г']);

    // Вложенная группа; внешнюю — в её же вложенную нельзя
    const outer = await s.groupLayers(['c', 'b'], 'Внешняя');
    const inner = await s.groupLayers(['c'], 'Внутри');
    expect(stack(doc)).toEqual(['a', 'b@Внешняя', 'c@Внутри']);
    expect(doc.group(inner).group).toBe(outer);
    const steps = (doc as unknown as { undoStack: unknown[] }).undoStack.length;
    await s.moveLayer(outer, inner, null);
    expect((doc as unknown as { undoStack: unknown[] }).undoStack.length).toBe(steps);
    await s.setGroupHidden(outer, true);
    expect(px(doc, 230, 30)).toEqual(BG);
  });

  it('разгруппировать — слои на её месте; удалить группу — со слоями, ⌘Z возвращает', async () => {
    const { s, doc } = await setup();
    const g = await s.groupLayers(['a', 'b'], 'Г');
    expect(stack(doc)).toEqual(['a@Г', 'b@Г', 'c']);
    await s.ungroup(g);
    expect(stack(doc)).toEqual(['a', 'b', 'c']);
    await s.undo();
    expect(stack(doc)).toEqual(['a@Г', 'b@Г', 'c']);

    await s.deleteGroup(g);
    expect(stack(doc)).toEqual(['c']);
    expect(doc.groups).toEqual([]);
    expect(doc.patches.map((p) => p.id)).toEqual(['c-v']);
    expect(px(doc, 50, 50)).toEqual(BG);
    await s.undo();
    expect(stack(doc)).toEqual(['a@Г', 'b@Г', 'c']);
    expect(px(doc, 110, 110)).toEqual(BLUE);
  });

  it('новый слой из выделения — сверху группы; объединённый — в группе верхнего', async () => {
    const { s, doc } = await setup();
    const g = await s.groupLayers(['a', 'b'], 'Г');
    const copy = await s.saveObject([{ kind: 'rect', x: 10, y: 150, width: 40, height: 40 }], 'Копия', g);
    expect(stack(doc)).toEqual(['a@Г', 'b@Г', `${copy}@Г`, 'c']);
    const merged = await s.mergeLayers(['a', 'b']);
    expect(doc.object(merged).group).toBe(g);
  });

  it('проект .caaa помнит группы и видимость', async () => {
    const { s, doc } = await setup();
    const g = await s.groupLayers(['a', 'c'], 'Небо');
    await s.setGroupHidden(g, true);
    const opened = (await openProject(await encodeProject(doc), 'x.caaa')).doc;
    expect(stack(opened)).toEqual(stack(doc));
    expect(opened.groups).toEqual(doc.groups);
    expect(opened.composite.equals(doc.composite)).toBe(true);
    expect(opened.objects.map((o) => o.hidden)).toEqual(doc.objects.map((o) => o.hidden));
  });
});

// Порядок слоёв: слой перетаскивают выше или ниже — холст пересобирается, части и заплатка фона едут с ним, ⌘Z возвращает.
import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '../src/core/document.ts';
import { noKeys } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';

const W = 300;
const H = 240;

/** Слой с одной видимой версией: непрозрачный квадрат цвета color */
function addLayer(doc: CanvasDocument, id: string, x: number, y: number, size: number, color: number[], extra: object = {}) {
  const layer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) layer.set([...color, 255], i * 4);
  const rect = { x, y, width: size, height: size };
  doc.setObjects([...doc.objects, { id, name: id, rect, mask: new Uint8Array(size * size).fill(255), createdAt: '', version: 1, current: `${id}-v`, ...extra }]);
  doc.addPatch({ id: `${id}-v`, rect, layer, prompt: id, jobId: id, variant: 0, createdAt: '', object: id });
}

const px = (doc: CanvasDocument, x: number, y: number) => [...doc.composite.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
const RED = [220, 30, 30];
const BLUE = [30, 30, 220];
const GREEN = [30, 200, 30];

async function setup() {
  const s = new Session('mock', noKeys());
  await s.newDocument(W, H, [250, 250, 250]);
  const doc = s.doc!;
  addLayer(doc, 'a', 40, 40, 100, RED);
  addLayer(doc, 'b', 90, 90, 100, BLUE);
  return { s, doc };
}

describe('Порядок слоёв', () => {
  it('слой над другим — он виден там, где они перекрываются; ⌘Z возвращает; на своём месте — без шага отмены', async () => {
    const { s, doc } = await setup();
    expect(px(doc, 110, 110)).toEqual(BLUE);
    const before = Buffer.from(doc.composite);

    await s.moveLayer('a', null, 'b');
    expect(doc.objects.map((o) => o.id)).toEqual(['b', 'a']);
    expect(px(doc, 110, 110)).toEqual(RED);
    // Там, где они не перекрываются, — как было
    expect(px(doc, 50, 50)).toEqual(RED);
    expect(px(doc, 180, 180)).toEqual(BLUE);
    expect(doc.contentKey).not.toBe('');

    await s.undo();
    expect(doc.objects.map((o) => o.id)).toEqual(['a', 'b']);
    expect(doc.composite.equals(before)).toBe(true);
    await s.redo();
    expect(px(doc, 110, 110)).toEqual(RED);

    // Под всеми — снова под синим; туда же ещё раз — ничего не меняется
    await s.moveLayer('a', null, null);
    expect(px(doc, 110, 110)).toEqual(BLUE);
    const steps = (doc as unknown as { undoStack: unknown[] }).undoStack.length;
    await s.moveLayer('a', null, null);
    await s.moveLayer('b', null, 'a');
    expect((doc as unknown as { undoStack: unknown[] }).undoStack.length).toBe(steps);
  });

  it('части слоя едут с ним, заплатка фона остаётся прямо под ним', async () => {
    const { s, doc } = await setup();
    addLayer(doc, 'part', 60, 60, 30, GREEN, { parent: 'a' });
    addLayer(doc, 'fill', 40, 40, 100, [200, 200, 200], { kind: 'fill', under: 'a' });
    const order = () => doc.drawOrder().map((p) => p.object);
    // Часть из старого проекта, появившаяся позже, — выше всех, заплатка — прямо под своим слоем
    expect(order()).toEqual(['fill', 'a', 'b', 'part']);

    await s.moveLayer('a', null, 'b');
    expect(order()).toEqual(['b', 'fill', 'a', 'part']);
    expect(px(doc, 110, 110)).toEqual(RED);
    expect(px(doc, 70, 70)).toEqual(GREEN);

    // Часть — не место в стопке: она едет со своим слоем
    await expect(s.moveLayer('b', null, 'part')).rejects.toThrow();
    expect(order()).toEqual(['b', 'fill', 'a', 'part']);

    // Синий — над красным с частью: над частью тоже
    await s.moveLayer('b', null, 'a');
    expect(order()).toEqual(['fill', 'a', 'part', 'b']);
  });
});

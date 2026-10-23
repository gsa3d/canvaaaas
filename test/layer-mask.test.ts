import { describe, expect, it } from 'vitest';
import { CanvasDocument } from '../src/core/document.ts';
import { featherAlpha } from '../src/core/mask.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';

const W = 900;
const H = 700;
const R = { x: 100, y: 120, width: 400, height: 300 };

/** Слой как после принятия: цвет ответа модели на весь прямоугольник, альфа — растушёванная маска */
function accepted(mask: Uint8Array, feather: number, color: [number, number, number] = [220, 30, 30]) {
  const alpha = featherAlpha(mask, R.width, R.height, feather);
  const layer = Buffer.alloc(R.width * R.height * 4);
  for (let i = 0; i < alpha.length; i++) layer.set([...color, Math.round(alpha[i]! * 255)], i * 4);
  return { id: 'a', rect: R, layer, mask, feather, prompt: 'a', jobId: 'a', variant: 0, createdAt: '' };
}

/** Маска — левая половина слоя */
function leftHalf(): Uint8Array {
  const mask = new Uint8Array(R.width * R.height);
  for (let y = 0; y < R.height; y++) mask.fill(255, y * R.width, y * R.width + R.width / 2);
  return mask;
}

function px(doc: CanvasDocument, x: number, y: number): number[] {
  const i = (y * doc.width + x) * 3;
  return [...doc.composite.subarray(i, i + 3)];
}

describe('Маска слоя', () => {
  it('стёртое — побайтно как под слоем, возвращённое — пиксели модели; отмена и повтор точны', () => {
    const doc = CanvasDocument.blank(W, H, [10, 20, 30], 'test');
    doc.addPatch(accepted(leftHalf(), 0));
    const withLayer = Buffer.from(doc.composite);
    const key = doc.contentKey;
    expect(px(doc, R.x + 300, R.y + 150)).toEqual([10, 20, 30]);

    doc.setPatchMask('a', new Uint8Array(R.width * R.height));
    expect(doc.composite.equals(doc.base)).toBe(true);
    expect(doc.contentKey).not.toBe(key);

    doc.undo();
    expect(doc.composite.equals(withLayer)).toBe(true);
    expect(doc.contentKey).toBe(key);
    doc.redo();
    expect(doc.composite.equals(doc.base)).toBe(true);

    // За краем исходной маски тоже лежит ответ модели: кисть его открывает
    doc.setPatchMask('a', new Uint8Array(R.width * R.height).fill(255));
    expect(px(doc, R.x + 300, R.y + 150)).toEqual([220, 30, 30]);
  });

  it('правка маски скрытого слоя холст не меняет и проявляется, когда его покажут', () => {
    const doc = CanvasDocument.blank(W, H, [10, 20, 30], 'test');
    doc.addPatch(accepted(leftHalf(), 0));
    doc.togglePatch('a');
    const key = doc.contentKey;
    doc.setPatchMask('a', new Uint8Array(R.width * R.height).fill(255));
    expect(doc.composite.equals(doc.base)).toBe(true);
    expect(doc.contentKey).toBe(key);
    doc.togglePatch('a');
    expect(px(doc, R.x + 300, R.y + 150)).toEqual([220, 30, 30]);
  });

  it('ластиком по маске с растушёвкой: где маска стала 0, пиксели равны холсту под слоем; ⌘Z сразу после мазка отменяет его', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, [10, 20, 30]);
    const doc = s.doc!;
    // Нижний слой на всю ширину, сверху — правимый
    const under = accepted(new Uint8Array(R.width * R.height).fill(255), 0, [30, 200, 30]);
    doc.addPatch({ ...under, id: 'under' });
    const beneath = Buffer.from(doc.composite);
    doc.addPatch(accepted(leftHalf(), 24));
    const withLayer = Buffer.from(doc.composite);

    const hole = { x: R.x + 40, y: R.y + 60, width: 100, height: 120 };
    await s.editPatchMask('a', [{ kind: 'rect', ...hole, erase: true }]);
    expect(s.dirty).toBe(true);
    for (let y = hole.y; y < hole.y + hole.height; y++) {
      for (let x = hole.x; x < hole.x + hole.width; x++) {
        const i = (y * W + x) * 3;
        expect(doc.composite.subarray(i, i + 3).equals(beneath.subarray(i, i + 3)), `${x},${y}`).toBe(true);
      }
    }
    // Растушёвка внутрь: у края дыры слой полупрозрачный, дальше от неё — как был
    expect(px(doc, hole.x + hole.width + 4, hole.y + 60)).not.toEqual(px(doc, hole.x + hole.width + 60, hole.y + 60));

    const edit = s.editPatchMask('a', [{ kind: 'rect', x: R.x, y: R.y, width: 50, height: 50, erase: true }]);
    const undo = s.undo();
    await Promise.all([edit, undo]);
    // Отменился угол, а не дыра: без очереди отмена успела бы раньше мазка и сняла дыру
    expect(px(doc, R.x + 10, R.y + 10)).toEqual([220, 30, 30]);
    expect(px(doc, hole.x + 50, hole.y + 60)).toEqual([30, 200, 30]);
    await s.undo();
    expect(doc.composite.equals(withLayer)).toBe(true);
    expect(s.state().history.map((p) => p.maskRev)).toEqual([0, 0]);
  });
});

// Влить слой в фон, объединить слои, свести все: картинка та же, слоёв меньше, ⌘Z возвращает всё.
import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '../src/core/document.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';

const W = 300;
const H = 200;

/** Слой с одной видимой версией: квадрат цвета color, полупрозрачный по краю */
function addLayer(doc: CanvasDocument, id: string, x: number, y: number, size: number, color: [number, number, number]) {
  const layer = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const edge = px < 2 || py < 2 || px >= size - 2 || py >= size - 2;
      layer.set([...color, edge ? 128 : 255], (py * size + px) * 4);
    }
  }
  const rect = { x, y, width: size, height: size };
  doc.setObjects([...doc.objects, { id, name: id, rect, mask: new Uint8Array(size * size).fill(255), createdAt: '', version: 1, current: `${id}-v` }]);
  doc.addPatch({ id: `${id}-v`, rect, layer, prompt: id, jobId: id, variant: 0, createdAt: '', object: id });
}

async function setup() {
  const s = new Session('mock', envOnlyStore());
  await s.newDocument(W, H, [250, 250, 250]);
  return { s, doc: s.doc! };
}

const maxDiff = (a: Buffer, b: Buffer) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

describe('Влить в фон', () => {
  it('видимое ложится в исходник, слой с версиями уходит; картинка та же; ⌘Z возвращает и слой, и исходник', async () => {
    const { s, doc } = await setup();
    addLayer(doc, 'небо', 20, 20, 60, [40, 90, 200]);
    // Вторая, невидимая версия того же слоя тоже уходит
    doc.addPatch({ id: 'небо-v2', rect: { x: 20, y: 20, width: 10, height: 10 }, layer: Buffer.alloc(400, 255), prompt: '', jobId: 'j', variant: 1, createdAt: '', object: 'небо' });
    const before = Buffer.from(doc.composite);
    const base = Buffer.from(doc.base);
    const key = doc.contentKey;

    await s.mergeIntoBase('небо');
    expect(doc.objects).toHaveLength(0);
    expect(doc.patches).toHaveLength(0);
    expect(doc.composite.equals(before)).toBe(true);
    expect(doc.base.equals(before)).toBe(true);
    expect(doc.contentKey).not.toBe(key);
    expect(s.dirty).toBe(true);

    await s.undo();
    expect(doc.objects.map((o) => o.id)).toEqual(['небо']);
    expect(doc.patches).toHaveLength(2);
    expect(doc.base.equals(base)).toBe(true);
    expect(doc.composite.equals(before)).toBe(true);
    expect(doc.contentKey).toBe(key);
    await s.redo();
    expect(doc.base.equals(before)).toBe(true);
    expect(doc.objects).toHaveLength(0);
  });

  it('под слоем виден другой слой — нельзя; нижний вливается, тогда и верхний', async () => {
    const { s, doc } = await setup();
    addLayer(doc, 'лес', 20, 20, 60, [30, 120, 40]);
    addLayer(doc, 'птица', 60, 60, 40, [10, 10, 10]);
    addLayer(doc, 'солнце', 200, 20, 30, [250, 200, 0]);
    const before = Buffer.from(doc.composite);
    await expect(s.mergeIntoBase('птица')).rejects.toThrow('«лес»');
    // Слой, ни с кем не пересекающийся, вливается сразу
    await s.mergeIntoBase('солнце');
    await s.mergeIntoBase('лес');
    await s.mergeIntoBase('птица');
    expect(doc.objects).toHaveLength(0);
    expect(doc.composite.equals(before)).toBe(true);
  });

  it('проект .caaa хранит исходник с влитым слоем', async () => {
    const { s, doc } = await setup();
    addLayer(doc, 'небо', 20, 20, 60, [40, 90, 200]);
    await s.mergeIntoBase('небо');
    const { doc: back } = await openProject(await encodeProject(doc), 'x.caaa');
    expect(back.base.equals(doc.base)).toBe(true);
    expect(back.composite.equals(doc.composite)).toBe(true);
    // Ещё раз влили — PNG исходника не тот, что в кэше
    addLayer(doc, 'облако', 150, 100, 30, [255, 255, 255]);
    await s.mergeIntoBase('облако');
    const { doc: again } = await openProject(await encodeProject(doc), 'x.caaa');
    expect(again.base.equals(doc.base)).toBe(true);
  });
});

describe('Объединить слои', () => {
  it('один слой на месте верхнего, с его именем; версии уходят; картинка та же; ⌘Z возвращает', async () => {
    const { s, doc } = await setup();
    addLayer(doc, 'лес', 20, 20, 60, [30, 120, 40]);
    addLayer(doc, 'солнце', 200, 20, 30, [250, 200, 0]);
    addLayer(doc, 'птица', 60, 60, 40, [10, 10, 10]);
    doc.addPatch({ id: 'лес-v2', rect: { x: 20, y: 20, width: 10, height: 10 }, layer: Buffer.alloc(400, 255), prompt: '', jobId: 'j', variant: 1, createdAt: '', object: 'лес' });
    const before = Buffer.from(doc.composite);

    const id = await s.mergeLayers(['лес', 'птица']);
    expect(doc.objects.map((o) => o.name)).toEqual(['солнце', 'птица']);
    expect(doc.objects[1]!.id).toBe(id);
    const merged = doc.patches.filter((p) => p.object === id);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.lifted).toBe(true);
    expect(doc.object(id).rect).toEqual({ x: 20, y: 20, width: 80, height: 80 });
    // Полупрозрачные края сведены одной альфой: не больше единицы округления
    expect(maxDiff(doc.composite, before)).toBeLessThanOrEqual(1);

    await s.undo();
    expect(doc.objects.map((o) => o.id)).toEqual(['лес', 'солнце', 'птица']);
    expect(doc.patches).toHaveLength(4);
    expect(doc.composite.equals(before)).toBe(true);
    await expect(s.mergeLayers(['лес'])).rejects.toThrow('два');
  });
});

describe('Свести все слои', () => {
  it('видимое становится исходником, слоёв нет; ⌘Z возвращает всё', async () => {
    const { s, doc } = await setup();
    addLayer(doc, 'лес', 20, 20, 60, [30, 120, 40]);
    addLayer(doc, 'птица', 60, 60, 40, [10, 10, 10]);
    await s.setHidden('птица', true);
    const before = Buffer.from(doc.composite);
    const base = Buffer.from(doc.base);

    await s.flattenLayers();
    expect(doc.objects).toHaveLength(0);
    expect(doc.patches).toHaveLength(0);
    expect(doc.base.equals(before)).toBe(true);
    expect(doc.composite.equals(before)).toBe(true);
    await expect(s.flattenLayers()).rejects.toThrow('нечего');

    await s.undo();
    expect(doc.objects).toHaveLength(2);
    expect(doc.base.equals(base)).toBe(true);
    expect(doc.composite.equals(before)).toBe(true);
  });
});

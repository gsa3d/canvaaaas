// Удаление слоя, версии слоя и подсказка о разрешении до генерации.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CanvasDocument } from '../src/core/document.ts';
import { applyLayer, prepareEdit } from '../src/core/edit-region.ts';
import { adviseSize } from '../src/core/frame.ts';
import { featherAlpha } from '../src/core/mask.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { laozhangGemini } from '../src/providers/laozhang-gemini.ts';
import { mockProvider } from '../src/providers/mock.ts';
import { Session } from '../src/server/session.ts';

const W = 900;
const H = 700;
const BASE: [number, number, number] = [10, 20, 30];
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvaaaas-variants-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function solid(id: string, x: number, y: number, size: number, color: [number, number, number], alpha = 200) {
  const layer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) layer.set([...color, alpha], i * 4);
  return { id, rect: { x, y, width: size, height: size }, layer, prompt: id, jobId: id, variant: 0, createdAt: '' };
}

/** Холст из исходника и слоёв по порядку — то, что должно получиться */
function expected(doc: CanvasDocument, layers: ReturnType<typeof solid>[]): Buffer {
  const out = Buffer.from(doc.base);
  for (const l of layers) applyLayer({ data: out, rect: { x: 0, y: 0, width: doc.width, height: doc.height }, channels: 3 }, l.rect, l.layer);
  return out;
}

describe('Удаление и замена слоя', () => {
  it('удалённый слой — как будто его не было; ⌘Z возвращает его на прежнее место в стопке', () => {
    const doc = CanvasDocument.blank(1200, 900, BASE, 'test');
    const a = solid('a', 100, 100, 500, [200, 0, 0]);
    const b = solid('b', 300, 300, 500, [0, 200, 0]);
    const c = solid('c', 500, 200, 500, [0, 0, 200]);
    for (const p of [a, b, c]) doc.addPatch(p);
    const all = Buffer.from(doc.composite);

    doc.removePatch('b');
    expect(doc.composite.equals(expected(doc, [a, c]))).toBe(true);
    expect(doc.patches.map((p) => p.id)).toEqual(['a', 'c']);
    doc.undo();
    expect(doc.patches.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(doc.composite.equals(all)).toBe(true);
    doc.redo();
    expect(doc.composite.equals(expected(doc, [a, c]))).toBe(true);
  });

  it('новый вариант ложится на место слоя, под верхними; участок без слоя — как холст без него', () => {
    const doc = CanvasDocument.blank(1200, 900, BASE, 'test');
    const a = solid('a', 100, 100, 500, [200, 0, 0]);
    const top = solid('top', 400, 400, 400, [0, 200, 0]);
    doc.addPatch(a);
    doc.addPatch(top);
    const before = Buffer.from(doc.composite);

    const rect = { x: 50, y: 50, width: 700, height: 600 };
    const under = doc.regionWithout(rect, 'a');
    doc.togglePatch('a');
    for (let row = 0; row < rect.height; row++) {
      const from = ((rect.y + row) * doc.width + rect.x) * 3;
      expect(under.subarray(row * rect.width * 3, (row + 1) * rect.width * 3).equals(doc.composite.subarray(from, from + rect.width * 3))).toBe(true);
    }
    doc.undo();

    const a2 = solid('a2', 150, 120, 450, [250, 250, 0], 255);
    doc.replacePatch('a', a2);
    expect(doc.patches.map((p) => p.id)).toEqual(['a2', 'top']);
    expect(doc.composite.equals(expected(doc, [a2, top]))).toBe(true);
    doc.undo();
    expect(doc.composite.equals(before)).toBe(true);
    doc.redo();
    expect(doc.composite.equals(expected(doc, [a2, top]))).toBe(true);
  });

  it('удалить скрытый слой проекта .caaa — несохранённое изменение, хотя холст тот же', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(320, 240, BASE);
    s.doc!.addPatch(solid('a', 10, 10, 100, [200, 0, 0]));
    s.doc!.togglePatch('a');
    const path = join(dir, 'hidden.caaa');
    await writeFile(path, await encodeProject(s.doc!));

    const t = new Session('mock', envOnlyStore());
    await t.openPath(path);
    const key = t.doc!.contentKey;
    await t.removePatch('a');
    expect(t.doc!.contentKey).toBe(key);
    expect(t.dirty).toBe(true);
    await t.undo();
    expect(t.dirty).toBe(false);
  });

  it('проект помнит модель, разрешение и референсы слоя; общий референс хранится один раз', async () => {
    const doc = CanvasDocument.blank(320, 240, BASE, 'test');
    const jpeg = (color: string) => sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).jpeg().toBuffer();
    const hero = { data: await jpeg('#c33'), mimeType: 'image/jpeg' };
    const style = { data: await jpeg('#33c'), mimeType: 'image/jpeg' };
    doc.addPatch({ ...solid('a', 10, 10, 100, [200, 0, 0]), model: 'pro', size: '2K', refs: [hero, style] });
    doc.addPatch({ ...solid('b', 120, 60, 100, [0, 200, 0]), model: 'flash', size: 'auto', refs: [hero] });
    doc.addPatch(solid('c', 200, 100, 80, [0, 0, 200]));

    const data = await encodeProject(doc);
    const plain = await encodeProject(CanvasDocument.restore('x', 320, 240, doc.base, doc.patches.map((p) => ({ ...p, refs: undefined }))));
    expect(data.length - plain.length).toBeLessThan(hero.data.length + style.data.length + 400);

    const [a, b, c] = (await openProject(data, 'x.caaa')).doc.patches;
    expect([a!.model, a!.size, b!.model, b!.size, c!.model, c!.size]).toEqual(['pro', '2K', 'flash', 'auto', undefined, undefined]);
    expect(a!.refs!.map((r) => r.data.equals(hero.data) || r.data.equals(style.data))).toEqual([true, true]);
    expect(a!.refs![0]!.data.equals(hero.data)).toBe(true);
    expect(b!.refs![0]).toBe(a!.refs![0]);
    expect(c!.refs).toBeUndefined();
  });
});

describe('Версии слоя', () => {
  const sel = { x: 250, y: 200, width: 400, height: 300 };
  const R = { x: 150, y: 100, width: 600, height: 500 };

  /** Версия «красный шар»: красный на весь прямоугольник, маска — выделение, растушёвка 24 */
  function redLayer() {
    const mask = new Uint8Array(R.width * R.height);
    for (let y = sel.y - R.y; y < sel.y - R.y + sel.height; y++) mask.fill(255, y * R.width + sel.x - R.x, y * R.width + sel.x - R.x + sel.width);
    const alpha = featherAlpha(mask, R.width, R.height, 24);
    const layer = Buffer.alloc(R.width * R.height * 4);
    for (let i = 0; i < alpha.length; i++) layer.set([220, 30, 30, Math.round(alpha[i]! * 255)], i * 4);
    return { id: 'a', rect: R, layer, mask, feather: 24, prompt: 'красный шар', jobId: 'j', variant: 0, createdAt: '', model: 'flash' as const, size: 'auto' as const, object: 'ball' };
  }

  async function until(check: () => boolean): Promise<void> {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > 15_000) throw new Error('Не дождались');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Слой «шар» с версией «красный шар» на холсте и над ним слой «верх», задевающий угол выделения */
  async function setup() {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, BASE);
    const doc = s.doc!;
    const mask = new Uint8Array(sel.width * sel.height).fill(255);
    doc.setObjects([
      { id: 'ball', name: 'шар', rect: sel, mask, createdAt: '', version: 1, current: 'a' },
      { id: 'top-layer', name: 'верх', rect: { x: 560, y: 380, width: 200, height: 200 }, mask: new Uint8Array(200 * 200).fill(255), createdAt: '', version: 2, current: 'top' },
    ]);
    doc.addPatch(redLayer());
    doc.addPatch({ ...solid('top', 560, 380, 200, [30, 200, 30], 255), object: 'top-layer' });
    const id = s.patchVariants('a', { variants: 1, model: 'pro', size: '2K' });
    const job = () => s.state().jobs.find((j) => j.id === id)!;
    await until(() => job().status === 'done');
    return { s, doc, id, job };
  }

  it('ещё варианты версии: модель видит холст без неё, новый вариант — новая версия того же слоя и сразу на холсте; ⌘Z возвращает прежнюю', { timeout: 30_000 }, async () => {
    const { s, doc, job } = await setup();
    const { variants, selected, from, object, model } = job();
    expect({ from, object, model }).toEqual({ from: 'a', object: 'ball', model: 'flash' });
    expect(variants.map((v) => v.current ?? false)).toEqual([true, false]);
    expect(variants[0]!.patch).toBe('a');
    expect(selected).toBe(1);
    const fresh = variants[1]!.patch!;
    expect(doc.object('ball')).toMatchObject({ current: fresh });
    expect(s.state().objects.find((o) => o.id === 'ball')!.versions).toEqual(['a', fresh]);

    const canvas = (x: number, y: number) => [...doc.composite.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    // В углу выделения, вне «объекта» подставной модели, — цвет холста под версией, а не красный
    const corner = canvas(sel.x + 10, sel.y + 10);
    for (const [c, v] of BASE.entries()) expect(Math.abs(corner[c]! - v)).toBeLessThan(16);
    // Слой «верх» остался над шаром
    expect(canvas(600, 420)).toEqual([30, 200, 30]);

    await s.undo();
    expect(doc.object('ball').current).toBe('a');
    expect(canvas(sel.x + 200, sel.y + 150)).toEqual([220, 30, 30]);
  });

  it('переключение версии, исходник, скрытие; удалённая текущая — слой показывает предыдущую', { timeout: 30_000 }, async () => {
    const { s, doc, job } = await setup();
    const fresh = job().variants[1]!.patch!;
    const canvas = (x: number, y: number) => [...doc.composite.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    const mid: [number, number] = [sel.x + 200, sel.y + 150];
    await s.setCurrent('ball', 'a');
    expect(canvas(...mid)).toEqual([220, 30, 30]);
    await s.setCurrent('ball', null);
    expect(canvas(...mid)).toEqual(BASE);
    await expect(s.setCurrent('ball', 'top')).rejects.toThrow('не версия');
    await s.setCurrent('ball', 'a');
    await s.setHidden('ball', true);
    expect(canvas(...mid)).toEqual(BASE);
    expect(canvas(600, 420)).toEqual([30, 200, 30]);
    await s.setHidden('ball', false);
    expect(canvas(...mid)).toEqual([220, 30, 30]);

    await s.setCurrent('ball', fresh);
    await s.removePatch(fresh);
    expect(doc.object('ball').current).toBe('a');
    expect(canvas(...mid)).toEqual([220, 30, 30]);
    await s.undo();
    expect(doc.object('ball').current).toBe(fresh);
    // Проект помнит текущую версию и скрытие
    await s.setHidden('ball', true);
    const back = (await openProject(await encodeProject(doc), 'x.caaa')).doc;
    expect(back.object('ball')).toMatchObject({ current: fresh, hidden: true });
    expect(back.composite.equals(doc.composite)).toBe(true);
  });
});

describe('Подсказка о разрешении', () => {
  const canvas = { width: 8000, height: 6000 };
  const gemini = laozhangGemini({ apiKey: async () => 'test' });

  it('совпадает с тем, что потом выберет prepareEdit', async () => {
    const provider = mockProvider();
    const image = { data: Buffer.alloc(3000 * 2000 * 3, 90), width: 3000, height: 2000, channels: 3 as const };
    for (const [box, size] of [
      [{ x: 1000, y: 700, width: 300, height: 200 }, 'auto'],
      [{ x: 200, y: 100, width: 1500, height: 900 }, 'auto'],
      [{ x: 400, y: 300, width: 700, height: 900 }, '1K'],
    ] as const) {
      const mask = Buffer.alloc(3000 * 2000);
      for (let y = box.y; y < box.y + box.height; y++) mask.fill(255, y * 3000 + box.x, y * 3000 + box.x + box.width);
      const prep = await prepareEdit({ image, mask: { data: mask, width: 3000, height: 2000, channels: 1 }, prompt: 'x', provider, imageSize: size });
      const advice = adviseSize(box, image, provider, size);
      expect(advice.frame).toEqual(prep.frame);
      expect(advice.imageSize).toBe(prep.imageSize);
      expect(advice.tooSmall).toBe(prep.warnings.some((w) => w.includes('детализация упадёт')));
    }
    // Три подготовки куска на картинке 3000×2000: при загруженной машине дольше 5 секунд
  }, 20_000);

  it('мало — предлагает разрешение, которого хватит; много — меньшее; авто не берёт 4K само', () => {
    const small = { x: 4000, y: 3000, width: 400, height: 300 };
    expect(adviseSize(small, canvas, gemini, 'auto')).toMatchObject({ imageSize: '1K', enough: '1K', tooSmall: false, tooBig: false });
    expect(adviseSize(small, canvas, gemini, '4K')).toMatchObject({ enough: '1K', tooSmall: false, tooBig: true });

    const big = { x: 1000, y: 1000, width: 2000, height: 1500 };
    expect(adviseSize(big, canvas, gemini, 'auto')).toMatchObject({ imageSize: '2K', enough: '4K', tooSmall: true, beyond: false });
    expect(adviseSize(big, canvas, gemini, '1K')).toMatchObject({ enough: '4K', tooSmall: true, tooBig: false });
    expect(adviseSize(big, canvas, gemini, '4K')).toMatchObject({ tooSmall: false, tooBig: false });

    const huge = { x: 500, y: 500, width: 5000, height: 4000 };
    expect(adviseSize(huge, canvas, gemini, '4K')).toMatchObject({ enough: '4K', tooSmall: true, beyond: true });
  });
});

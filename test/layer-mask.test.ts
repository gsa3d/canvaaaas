import sharp from 'sharp';
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
    // Край дыры чёткий: растушёвка вклейки на мазок не ложится, сразу за ним слой виден целиком
    expect(px(doc, hole.x + hole.width, hole.y + 60)).toEqual([220, 30, 30]);

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

  it('мазок ложится прямо в прозрачность версии: мягкость 0 — чёткий край, мягкая кисть — плавный; ⌘Z возвращает как было', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, [10, 20, 30]);
    const doc = s.doc!;
    doc.addPatch(accepted(leftHalf(), 24));
    const withLayer = Buffer.from(doc.composite);
    const key = doc.contentKey;
    const alpha = (x: number) => doc.patch('a').layer[(150 * R.width + x) * 4 + 3]!;
    const line = (x: number, size: number, softness: number, erase = false) =>
      s.editPatchMask('a', [{ kind: 'stroke', points: [[R.x + x, R.y + 50], [R.x + x, R.y + 250]], size, softness, erase }]);

    // Жёсткий ластик внутри маски: сразу за краем мазка версия видна целиком
    await line(100, 40, 0, true);
    expect([alpha(100), alpha(78), alpha(122)]).toEqual([0, 255, 255]);
    // Жёсткая кисть за краем маски: тонкий мазок виден целиком, а не призраком (растушёвка 24 px оставила бы ~40%)
    await line(300, 20, 0);
    expect([alpha(300), alpha(312)]).toEqual([255, 0]);
    // Мягкая — плавно
    await line(350, 40, 1);
    expect(alpha(350)).toBeGreaterThan(245);
    expect(alpha(362)).toBeGreaterThan(20);
    expect(alpha(362)).toBeLessThan(235);
    // Растушёвка вклейки на прежнем краю маски — как была
    expect(alpha(190)).toBe(Math.round(featherAlpha(leftHalf(), R.width, R.height, 24)[150 * R.width + 190]! * 255));

    await s.undo();
    await s.undo();
    await s.undo();
    expect(doc.composite.equals(withLayer)).toBe(true);
    expect(doc.contentKey).toBe(key);
  });

  it('после правки рукой «Расширить» растушёвывает добавленное, «Ещё варианты» — с растушёвкой вклейки', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, [10, 20, 30]);
    const doc = s.doc!;
    doc.addPatch(accepted(leftHalf(), 24));
    await s.editPatchMask('a', [{ kind: 'stroke', points: [[R.x + 300, R.y + 50], [R.x + 300, R.y + 250]], size: 20, softness: 0 }]);
    // Модель нарисовала красное на весь кусок: маска растёт до края куска, но к нему не подходит, и край мягкий
    expect(await s.expandVersion('a')).toBeGreaterThan(0);
    const alpha = (x: number) => doc.patch('a').layer[(150 * R.width + x) * 4 + 3]!;
    expect(alpha(250)).toBe(255);
    expect(alpha(R.width - 1)).toBe(0);
    expect(alpha(R.width - 10)).toBeGreaterThan(20);
    expect(alpha(R.width - 10)).toBeLessThan(200);

    const more = s.patchVariants('a', { variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.find((j) => j.id === more)?.status === 'done');
    const fresh = doc.patches.find((p) => p.jobId === more)!;
    expect(fresh.feather).toBe(24);
  }, 20_000);

  it('кисть маски текущей версии за краем слоя растит и слой: его выделение и притушение — по тому, что видно; ⌘Z возвращает', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, [10, 20, 30]);
    const doc = s.doc!;
    // Слой — левая половина куска, у него две версии с ответом модели на весь кусок; видна «a»
    const half = { rect: { ...R, width: R.width / 2 }, mask: new Uint8Array((R.width / 2) * R.height).fill(255) };
    doc.setObjects([{ id: 'o', name: 'слой', ...half, createdAt: '', version: 1, current: 'a' }]);
    doc.addPatch({ ...accepted(leftHalf(), 0), object: 'o' });
    doc.addPatch({ ...accepted(leftHalf(), 0, [30, 30, 220]), id: 'b', object: 'o' });
    const stroke = { kind: 'rect' as const, x: R.x + 300, y: R.y + 100, width: 60, height: 60 };
    await s.editPatchMask('a', [stroke]);
    const o = doc.object('o');
    expect(o.rect.width).toBe(360);
    expect(o.mask[(stroke.y - o.rect.y + 30) * o.rect.width + stroke.x - o.rect.x + 30]).toBe(255);
    // Правка маски версии, которую не видно, слой не трогает
    await s.editPatchMask('b', [{ ...stroke, y: R.y + 200 }]);
    expect(doc.object('o').rect.height).toBe(R.height);
    expect(doc.object('o').version).toBe(o.version);
    await s.undo();
    await s.undo();
    expect(doc.object('o').rect).toEqual(half.rect);
  });

  it('миниатюра маски — прозрачность версии на весь кусок: белое видно, чёрное скрыто', async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, [10, 20, 30]);
    s.doc!.addPatch(accepted(leftHalf(), 0));
    const png = await s.maskThumbPng('a', 40);
    expect((await sharp(png).metadata()).channels).toBe(1);
    const { data, info } = await sharp(png).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([40, 30, 1]);
    expect(data[15 * 40 + 5]).toBe(255);
    expect(data[15 * 40 + 35]).toBe(0);
  });
});

async function until(ok: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ok()) {
    if (Date.now() - started > 15_000) throw new Error('Не дождались');
    await new Promise((r) => setTimeout(r, 30));
  }
}

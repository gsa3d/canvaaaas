// Скрыть от модели то, что под маской; повтор правки с поправкой задачи; быстрый пересчёт маски по участку
// и картинки, по которым браузер показывает правку маски сразу.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CanvasDocument } from '../src/core/document.ts';
import { applyLayer, prepareEdit, retarget } from '../src/core/edit-region.ts';
import { featherAlpha, featherAlphaRegion } from '../src/core/mask.ts';
import { applyShapes, applyShapesRegion } from '../src/core/mask-shapes.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { mockProvider } from '../src/providers/mock.ts';
import { Session } from '../src/server/session.ts';

const W = 900;
const H = 700;
const BASE: [number, number, number] = [10, 20, 30];

async function until(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 15_000) throw new Error('Не дождались');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Маска с дырой, островом и мягким краем — чтобы растушёвке было где ошибиться */
function bumpyMask(width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x - width * 0.45, y - height * 0.5);
      const ring = d < height * 0.4 && d > height * 0.12;
      const island = Math.abs(x - width * 0.85) < 20 && Math.abs(y - height * 0.2) < 15;
      mask[y * width + x] = ring || island ? 255 : d < height * 0.45 ? Math.round(255 * (1 - (d - height * 0.4) / (height * 0.05))) : 0;
    }
  }
  return mask;
}

function solid(id: string, x: number, y: number, size: number, color: [number, number, number], alpha: number) {
  const layer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) layer.set([...color, alpha], i * 4);
  return { id, rect: { x, y, width: size, height: size }, layer, prompt: id, jobId: id, variant: 0, createdAt: '' };
}

describe('Маска по участку', () => {
  it('растушёвка участка побайтно как у всей маски, в том числе у края массива', () => {
    const [w, h] = [400, 300];
    const mask = bumpyMask(w, h);
    const full = featherAlpha(mask, w, h, 24);
    for (const changed of [
      { x: 150, y: 100, width: 40, height: 30 },
      { x: 0, y: 0, width: 10, height: 300 },
      { x: 330, y: 40, width: 70, height: 20 },
    ]) {
      const { rect, alpha } = featherAlphaRegion(mask, w, h, 24, changed);
      expect(rect.x).toBeLessThanOrEqual(changed.x);
      for (let y = 0; y < rect.height; y++) {
        for (let x = 0; x < rect.width; x++) {
          const got = alpha[y * rect.width + x]!;
          const want = full[(rect.y + y) * w + rect.x + x]!;
          if (got !== want) throw new Error(`${rect.x + x},${rect.y + y}: ${got} вместо ${want}`);
        }
      }
    }
  });

  it('фигуры, растеризованные по участку, — та же маска, что целиком; фигуры мимо маску не меняют', async () => {
    const rect = { x: 50, y: 40, width: 300, height: 200 };
    const mask = bumpyMask(rect.width, rect.height);
    const shapes = [
      { kind: 'rect' as const, x: 120, y: 90, width: 60, height: 40, erase: true },
      { kind: 'stroke' as const, points: [[200, 100], [260, 160]] as [number, number][], size: 30 },
    ];
    const whole = await applyShapes(mask, rect, shapes);
    const { mask: part, changed } = await applyShapesRegion(mask, rect, shapes);
    expect(changed).not.toBeNull();
    expect(changed!.width).toBeLessThan(rect.width);
    expect(Buffer.from(part).equals(Buffer.from(whole))).toBe(true);
    expect(await applyShapesRegion(mask, rect, [{ kind: 'rect', x: 600, y: 600, width: 10, height: 10 }])).toEqual({ mask, changed: null });
  });

  it('слой с маской, пересчитанной по участку, побайтно как пересчитанный целиком; отмена — тоже', () => {
    const make = () => {
      const doc = CanvasDocument.blank(W, H, BASE, 'test');
      const rect = { x: 100, y: 80, width: 500, height: 400 };
      const mask = bumpyMask(rect.width, rect.height);
      const alpha = featherAlpha(mask, rect.width, rect.height, 24);
      const layer = Buffer.alloc(rect.width * rect.height * 4);
      for (let i = 0; i < alpha.length; i++) layer.set([220, 30, 30, Math.round(alpha[i]! * 255)], i * 4);
      doc.addPatch({ id: 'a', rect, layer, mask, feather: 24, prompt: 'a', jobId: 'a', variant: 0, createdAt: '' });
      return doc;
    };
    const fast = make();
    const slow = make();
    const before = Buffer.from(fast.composite);
    const changed = { x: 140, y: 150, width: 90, height: 60 };
    const next = new Uint8Array(fast.patch('a').mask);
    for (let y = changed.y; y < changed.y + changed.height; y++) next.fill(0, y * 500 + changed.x, y * 500 + changed.x + changed.width);
    fast.setPatchMask('a', next, changed);
    slow.setPatchMask('a', next);
    expect(fast.patch('a').layer.equals(slow.patch('a').layer)).toBe(true);
    expect(fast.composite.equals(slow.composite)).toBe(true);
    expect(fast.composite.equals(before)).toBe(false);
    fast.undo();
    expect(fast.composite.equals(before)).toBe(true);
  });

  it('холст под слоем, сам слой и слои над ним вместе дают тот же холст', () => {
    const doc = CanvasDocument.blank(1000, 800, BASE, 'test');
    doc.addPatch(solid('low', 50, 50, 500, [200, 0, 0], 180));
    doc.addPatch(solid('mid', 200, 150, 500, [0, 200, 0], 140));
    doc.addPatch(solid('top', 350, 300, 400, [0, 0, 200], 120));
    doc.addPatch(solid('top2', 400, 100, 300, [250, 250, 0], 90));
    const rect = { x: 150, y: 100, width: 600, height: 600 };
    const { below, above } = doc.regionAround(rect, 'mid');
    const out = { data: below, rect, channels: 3 };
    applyLayer(out, doc.patch('mid').rect, doc.patch('mid').layer);
    // Слои над правимым, сведённые в один RGBA, — как если бы их клали по одному
    applyLayer(out, rect, above);
    let worst = 0;
    for (let y = 0; y < rect.height; y++) {
      for (let x = 0; x < rect.width; x++) {
        for (let c = 0; c < 3; c++) {
          const got = out.data[(y * rect.width + x) * 3 + c]!;
          const want = doc.composite[((rect.y + y) * doc.width + rect.x + x) * 3 + c]!;
          worst = Math.max(worst, Math.abs(got - want));
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(2);
    // Без слоя — весь холст под новым слоем сверху
    const fresh = doc.regionAround(rect, null);
    expect(fresh.above.every((v) => v === 0)).toBe(true);
    expect(fresh.below.equals(doc.regionWithout(rect, 'no-such-layer'))).toBe(true);
  });
});

describe('Скрыть то, что под маской', () => {
  it('модель получает один кусок, где область залита серым, и промпт об этом; retarget меняет показ без новой подготовки', async () => {
    const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#c03030' } }).png().toBuffer();
    const mask = { data: Buffer.alloc(800 * 600), width: 800, height: 600, channels: 1 as const, x: 0, y: 0 };
    for (let y = 200; y < 400; y++) mask.data.fill(255, y * 800 + 300, y * 800 + 500);
    const prep = await prepareEdit({ image, mask, prompt: 'дракон', provider: mockProvider(), guide: 'blank' });
    expect(prep.images).toHaveLength(1);
    expect(prep.prompt).toContain('painted flat gray');
    const { data, info } = await sharp(prep.images[0]!.data).raw().toBuffer({ resolveWithObject: true });
    // Середина области в ответе модели — серая, а не красная исходная
    const centre = (Math.round(info.height / 2) * info.width + Math.round(info.width / 2)) * info.channels;
    for (const v of data.subarray(centre, centre + 3)) expect(Math.abs(v - 128)).toBeLessThan(8);

    const shown = await retarget(prep, { request: 'кот', guide: 'pair' });
    expect(shown.images).toHaveLength(2);
    expect(shown.prompt).toContain('TASK: кот');
    expect(shown.prompt).not.toContain('flat gray');
    const same = await retarget(prep, { request: 'пёс', guide: 'blank' });
    expect(same.images).toBe(prep.images);
  });
});

describe('Повтор с поправкой', () => {
  async function setup(hide: boolean) {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(W, H, BASE);
    const id = s.createJob({ shapes: [{ kind: 'rect', x: 300, y: 200, width: 240, height: 180 }], prompt: 'кот', variants: 1, model: 'flash', size: 'auto', hide });
    const job = () => s.state().jobs.find((j) => j.id === id)!;
    await until(() => job().status === 'done');
    return { s, id, job };
  }

  it('новые варианты идут с поправленной задачей, прежние остаются; принятый слой помнит задачу и скрытие своего варианта', { timeout: 30_000 }, async () => {
    const { s, id, job } = await setup(false);
    expect(job()).toMatchObject({ prompt: 'кот', hide: false });
    s.selectVariant(id, 0);
    const more = s.moreVariants(id, 1, { prompt: '  пёс  ', hide: true });
    // Пока идёт новый вариант, готовый остаётся на холсте
    expect(job().status).toBe('done');
    await expect(s.moreVariants(id, 1)).rejects.toThrow('ещё идёт');
    await more;
    const { variants, selected, prompt, hide } = job();
    expect({ prompt, hide }).toEqual({ prompt: 'пёс', hide: true });
    expect(variants.map((v) => [v.prompt, v.hide])).toEqual([
      ['кот', false],
      ['пёс', true],
    ]);
    // Задачу поправили — новый вариант сразу на холсте
    expect(selected).toBe(1);

    s.accept(id);
    const patch = s.state().history[0]!;
    expect(patch).toMatchObject({ prompt: 'пёс', hide: true });
    const reopened = await openProject(await encodeProject(s.doc!), 'x.caaa');
    expect(reopened.doc.patches[0]).toMatchObject({ prompt: 'пёс', hide: true });

    // «Ещё варианты» слоя с поправкой: нынешний слой — вариант по прежней задаче
    const again = s.patchVariants(patch.id, { variants: 1, model: 'flash', size: 'auto', prompt: 'лиса', hide: false });
    await until(() => s.state().jobs.find((j) => j.id === again)?.status === 'done');
    const redo = s.state().jobs.find((j) => j.id === again)!;
    expect(redo).toMatchObject({ prompt: 'лиса', hide: false, replaces: patch.id });
    expect(redo.variants.map((v) => [v.current ?? false, v.prompt, v.hide])).toEqual([
      [true, 'пёс', true],
      [false, 'лиса', false],
    ]);
  });

  it('картинки для правки маски — в размере куска, с номером состояния маски; мазок отдаёт новый номер', { timeout: 30_000 }, async () => {
    const { s, id, job } = await setup(true);
    const { inside, maskRev } = job();
    const meta = async (part: string) => {
      const img = await s.maskEditImage({ job: id, n: job().selected }, part);
      return { ...(await sharp(img.data).metadata()), version: img.version };
    };
    for (const part of ['below', 'above', 'layer', 'mask']) {
      expect(await meta(part)).toMatchObject({ width: inside!.width, height: inside!.height, version: maskRev });
    }
    const res = await s.editMask(id, [{ kind: 'stroke', points: [[350, 250], [400, 260]], size: 40, erase: true }]);
    expect(res).toEqual({ version: maskRev + 1, rev: job().rev });
    expect((await meta('mask')).version).toBe(maskRev + 1);
    await expect(s.maskEditImage({ job: id, n: 7 }, 'layer')).rejects.toThrow('не готов');

    s.accept(id);
    const patch = s.state().history[0]!;
    const before = s.doc!.rev;
    const edit = await s.editPatchMask(patch.id, [{ kind: 'rect', x: 0, y: 0, width: 5, height: 5 }]);
    expect(edit.rev).toBeGreaterThanOrEqual(before);
    const mask = await s.maskEditImage({ patch: patch.id }, 'mask');
    expect(mask.version).toBe(edit.version);
  });
});

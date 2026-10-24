// Набросок для модели и директор, который расписывает задачу перед генерацией.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildPrompt, directorImages, prepareEdit, retarget } from '../src/core/edit-region.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { checkSketch, drawSketch } from '../src/core/sketch.ts';
import { directorPrompt, parseDirector, type PromptDirector } from '../src/providers/director.ts';
import { mockProvider } from '../src/providers/mock.ts';
import { Session } from '../src/server/session.ts';
import type { SketchStroke } from '../src/shared/api.ts';

async function until(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 20_000) throw new Error('Не дождались');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const RED: SketchStroke = { points: [[200, 150], [400, 150]], size: 20, color: '#ff0000' };

function pixel(data: Uint8Array | Buffer, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 3;
  return [data[i]!, data[i + 1]!, data[i + 2]!];
}

describe('Набросок', () => {
  it('штрихи из запроса проверяются: не тот цвет или точки — ошибка, пусто — пустой набросок', () => {
    expect(checkSketch(undefined)).toEqual([]);
    expect(checkSketch([{ ...RED, color: '#FF0000', erase: false }])).toEqual([{ ...RED, erase: undefined }]);
    expect(() => checkSketch([{ ...RED, color: 'red' }])).toThrow();
    expect(() => checkSketch([{ ...RED, points: [[1, Number.NaN]] }])).toThrow();
    expect(() => checkSketch('штрих')).toThrow();
  });

  it('штрих ложится на своё место участка в размере картинки модели; ластик стирает только набросок', async () => {
    // Участок холста 400×200 в (100, 50), картинка модели вдвое меньше
    const rect = { x: 100, y: 50, width: 400, height: 200 };
    const size = { width: 200, height: 100 };
    const gray = new Uint8Array(size.width * size.height * 3).fill(128);
    const drawn = await drawSketch(gray, size, rect, [RED]);
    expect(pixel(drawn, size.width, 100, 50)).toEqual([255, 0, 0]);
    expect(pixel(drawn, size.width, 100, 80)).toEqual([128, 128, 128]);
    const erased = await drawSketch(gray, size, rect, [RED, { points: [[300, 150]], size: 40, color: '#000000', erase: true }]);
    expect(pixel(erased, size.width, 100, 50)).toEqual([128, 128, 128]);
    expect(pixel(erased, size.width, 60, 50)).toEqual([255, 0, 0]);
  });

  it('модель получает кусок с наброском после куска (и подсветки), промпт его объясняет, референсы идут следом', async () => {
    const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).png().toBuffer();
    const mask = { data: Buffer.alloc(800 * 600), width: 800, height: 600, channels: 1 as const, x: 0, y: 0 };
    for (let y = 100; y < 200; y++) mask.data.fill(255, y * 800 + 250, y * 800 + 450);
    const ref = { data: await sharp({ create: { width: 64, height: 64, channels: 3, background: '#00f' } }).jpeg().toBuffer(), mimeType: 'image/jpeg' };
    const prep = await prepareEdit({ image, mask, prompt: 'лодка', provider: mockProvider(), sketch: [RED], references: [ref, ref] });
    expect(prep.images).toHaveLength(5);
    expect(prep.images[3]).toBe(ref);
    expect(prep.prompt).toContain("Image 3 is the same crop with the artist's rough sketch");
    expect(prep.prompt).toContain('Images 4–5 are reference images');
    const [clean, , sketched] = await Promise.all(prep.images.slice(0, 3).map((img) => sharp(img.data).raw().toBuffer({ resolveWithObject: true })));
    // Середина штриха: на чистом куске серая, на куске с наброском — красная
    const { rect } = prep.frame;
    const x = Math.round(((300 - rect.x) / rect.width) * clean!.info.width);
    const y = Math.round(((150 - rect.y) / rect.height) * clean!.info.height);
    expect(pixel(clean!.data, clean!.info.width, x, y)[0]).toBeLessThan(140);
    const [r, g] = pixel(sketched!.data, sketched!.info.width, x, y);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);

    // Скрыть под маской: набросок поверх серого куска, вторая картинка
    const hidden = await retarget(prep, { request: 'лодка', guide: 'blank' });
    expect(hidden.images).toHaveLength(4);
    expect(hidden.prompt).toContain("Image 2 is the same crop with the artist's rough sketch");

    // Директору — всегда чистый кусок, подсветка и набросок, затем референсы
    expect(await directorImages(prep)).toHaveLength(5);

    // Набросок мимо куска модели не нужен
    const far = await prepareEdit({ image, mask, prompt: 'лодка', provider: mockProvider(), sketch: [{ ...RED, points: [[790, 590]], size: 4 }] });
    expect(far.images).toHaveLength(2);
    expect(far.sketch).toEqual([]);
    expect(far.warnings.join(' ')).toContain('Набросок не задевает кусок');
  });
});

describe('Директор', () => {
  it('модель получает текст директора задачей и слова художника рядом', async () => {
    const text = buildPrompt('pair', 'лодка', { directed: 'Paint a small red boat on the water.' });
    expect(text).toContain('TASK: Paint a small red boat on the water.');
    expect(text).toContain(`The artist's own words: "лодка"`);
    expect(buildPrompt('pair', 'лодка')).not.toContain('own words');
  });

  it('что директор видит и что должен ответить; ответ — между тегами', () => {
    const text = directorPrompt({ request: 'лодка', style: 'акварель', hide: true, sketch: true, overview: true, references: 2 });
    expect(text).toContain("Artist's task: лодка");
    expect(text).toContain('Style of the whole illustration: акварель');
    expect(text).toContain('will NOT see what is inside the area');
    expect(text).toContain("- Image 3: the same crop with the artist's rough sketch");
    expect(text).toContain('- Image 4: the whole illustration');
    expect(text).toContain('- Images 5–6: reference images');
    expect(directorPrompt({ request: 'x', hide: false, sketch: false, overview: false, references: 0 })).not.toMatch(/Image 3|NOT see|Style of/);

    expect(parseDirector('Sure!\n<task>\n  Paint a boat.\n Small, red.\n</task>')).toBe('Paint a boat. Small, red.');
    expect(parseDirector('Paint a boat.')).toBe('Paint a boat.');
    expect(() => parseDirector('<task> </task>')).toThrow('пустым');
  });

  it('директор — один раз на задачу: та же задача берёт его текст, поправленная зовёт заново; слой и проект его помнят', { timeout: 60_000 }, async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(900, 700, [40, 60, 80]);
    const sketch: SketchStroke[] = [{ points: [[350, 260], [420, 300]], size: 12, color: '#ff3b30' }];
    const id = s.createJob({ shapes: [{ kind: 'rect', x: 300, y: 200, width: 240, height: 180 }], prompt: 'лодка', variants: 1, model: 'flash', size: 'auto', sketch, director: true });
    const job = () => s.state().jobs.find((j) => j.id === id)!;
    await until(() => job().directing);
    expect(job().status).toBe('running');
    // Один шаг, затем критик смотрит его
    await until(() => job().status === 'done' && !job().chain);
    expect(job()).toMatchObject({ director: true, sketch: true });
    expect(job().directed).toMatch(/лодка.*#1/);
    expect(job().variants[0]!.directed).toBe(job().directed);

    // Ещё варианты той же задачи — без нового вызова директора
    await s.moreVariants(id, 1);
    expect(job().variants[1]!.directed).toMatch(/#1/);
    // Поправили задачу — директор заново
    await s.moreVariants(id, 1, { prompt: 'парусник' });
    expect(job().directed).toMatch(/парусник.*#2/);
    expect(job().variants[2]!.directed).toBe(job().directed);
    // Без директора — модель получает задачу как есть
    await s.moreVariants(id, 1, { director: false });
    expect(job()).toMatchObject({ director: false, directed: undefined });
    expect(job().variants[3]!.directed).toBeUndefined();

    s.selectVariant(id, 2);
    s.accept(id);
    const patch = s.state().history[0]!;
    expect(patch).toMatchObject({ prompt: 'парусник', sketch: true });
    expect(patch.directed).toMatch(/парусник.*#2/);
    const reopened = await openProject(await encodeProject(s.doc!), 'x.caaa');
    expect(reopened.doc.patches[0]).toMatchObject({ directed: patch.directed, sketch });

    // Ещё варианты слоя с той же задачей: директор включён, его текст — слоя, нового вызова нет
    const again = s.patchVariants(patch.id, { variants: 1, model: 'flash', size: 'auto' });
    const redo = () => s.state().jobs.find((j) => j.id === again)!;
    await until(() => redo().status === 'done' && redo().variants.length === 2);
    expect(redo()).toMatchObject({ director: true, sketch: true, directed: patch.directed });
    expect(redo().variants[1]!.directed).toBe(patch.directed);
  });

  it('ошибка директора — ошибка задачи с понятной причиной, генерации не тратятся; без директора повтор идёт', { timeout: 30_000 }, async () => {
    const s = new Session('mock', envOnlyStore());
    await s.newDocument(600, 400, [200, 200, 200]);
    const failing: PromptDirector = {
      id: 'failing',
      model: 'x',
      direct: () => Promise.reject(new Error('Codex не вошёл в ChatGPT')),
      review: () => Promise.reject(new Error('Codex не вошёл в ChatGPT')),
    };
    (s as unknown as { directorImpl: PromptDirector }).directorImpl = failing;
    const id = s.createJob({ shapes: [{ kind: 'rect', x: 100, y: 100, width: 120, height: 80 }], prompt: 'дом', variants: 2, model: 'flash', size: 'auto', director: true });
    const job = () => s.state().jobs.find((j) => j.id === id)!;
    await until(() => job().status === 'error');
    expect(job().error).toBe('Директор: Codex не вошёл в ChatGPT');
    expect(job().directing).toBe(false);
    expect(s.state().generations.session).toBe(0);
    await s.moreVariants(id, 1, { director: false });
    expect(job().status).toBe('done');
    expect(s.state().generations.session).toBe(1);
  });
});

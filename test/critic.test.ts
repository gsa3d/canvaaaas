// Шаги с критиком: с директором варианты идут не разом, а по очереди — критик смотрит каждый шаг и говорит,
// что исправить, следующий шаг исправляет это в нём же.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { blendFrame, buildPrompt, criticImages, prepareEdit, revise } from '../src/core/edit-region.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { criticPrompt, mockDirector, parseCritic, type PromptDirector } from '../src/providers/director.ts';
import { mockProvider } from '../src/providers/mock.ts';
import type { ImageProvider } from '../src/providers/types.ts';
import { Session } from '../src/server/session.ts';
import type { MaskShape } from '../src/shared/api.ts';

async function until(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 20_000) throw new Error('Не дождались');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const AREA: MaskShape = { kind: 'rect', x: 300, y: 200, width: 240, height: 180 };
const BG: [number, number, number] = [40, 60, 80];

/** Сеанс с подставной моделью без задержки и подставным директором-критиком, чьи вызовы видно */
async function session(opts: { doneAt?: number; delayMs?: number } = {}) {
  const s = new Session('mock', envOnlyStore());
  await s.newDocument(900, 700, BG);
  const provider = mockProvider({ mode: 'blob', delayMs: opts.delayMs });
  const director = mockDirector({ doneAt: opts.doneAt });
  (s as unknown as { providers: Map<string, ImageProvider> }).providers.set('flash', provider);
  (s as unknown as { directorImpl: PromptDirector }).directorImpl = director;
  const create = (variants: number) => s.createJob({ shapes: [AREA], prompt: 'лодка', variants, model: 'flash', size: 'auto', director: true });
  return { s, provider, director, create };
}

function jobOf(s: Session, id: string) {
  return () => s.state().jobs.find((j) => j.id === id)!;
}

describe('Критик: промпт и ответ', () => {
  it('что критик видит и что проверяет; если художник просит ещё шаг, «готово» не предлагается', () => {
    const text = criticPrompt({
      request: 'лодка',
      directed: 'Paint a small red boat.',
      style: 'акварель',
      hide: true,
      fixes: '- Make it smaller.',
      mustFix: false,
      sketch: true,
      overview: true,
      references: 2,
    });
    expect(text).toContain('- Image 3: the same crop after the edit.');
    expect(text).toContain("- Image 4: the crop before the edit with the artist's rough sketch");
    expect(text).toContain('- Image 5: the whole illustration');
    expect(text).toContain('- Images 6–7: reference images');
    expect(text).toContain("Artist's task: лодка");
    expect(text).toContain('spelled out for the image model: Paint a small red boat.');
    expect(text).toContain('painted the area from scratch');
    expect(text).toContain('This attempt was asked to fix:\n- Make it smaller.');
    expect(text).toContain('<done>');
    const must = criticPrompt({ request: 'лодка', hide: false, mustFix: true, sketch: false, overview: false, references: 0 });
    expect(must).not.toContain('<done>');
    expect(must).toContain('<fix>');
    expect(must).not.toMatch(/Image 4|spelled out|from scratch|asked to fix/);
  });

  it('ответ критика: «готово» или замечания по строке; без тегов — замечания; пустой — ошибка', () => {
    expect(parseCritic('Looks good.\n<done> The boat fits\n the scene. </done>')).toEqual({ done: true, text: 'The boat fits the scene.' });
    expect(parseCritic('<fix>\n- Smaller  boat.\n\n- Shadow to the left.\n</fix>')).toEqual({ done: false, text: '- Smaller boat.\n- Shadow to the left.' });
    expect(parseCritic('<done>ok</done><fix>- Smaller.</fix>')).toEqual({ done: false, text: '- Smaller.' });
    expect(parseCritic('- Smaller.')).toEqual({ done: false, text: '- Smaller.' });
    expect(() => parseCritic('<fix> </fix>')).toThrow('пустым');
  });

  it('промпт шага-исправления: задача остаётся, замечания — что исправить в прежней попытке', () => {
    const text = buildPrompt('pair', 'лодка', { directed: 'Paint a boat.', fixes: '- Smaller.\n- Shadow left.' });
    expect(text).toContain('Revise this illustration');
    expect(text).toContain('TASK: Paint a boat.');
    expect(text).toContain('FIX:\n- Smaller.\n- Shadow left.');
    expect(text).toContain('Apply the fixes to that area of image 1');
    expect(buildPrompt('pair', 'лодка')).not.toMatch(/FIX|Revise/);
  });
});

describe('Шаг-исправление: картинки', () => {
  it('прежняя попытка ложится на кусок по маске: вне маски — исходник; её же видят модель и критик', async () => {
    const image = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#808080' } }).png().toBuffer();
    const mask = { data: Buffer.alloc(800 * 600), width: 800, height: 600, channels: 1 as const, x: 0, y: 0 };
    for (let y = 200; y < 300; y++) mask.data.fill(255, y * 800 + 300, y * 800 + 500);
    const prep = await prepareEdit({ image, mask, prompt: 'лодка', provider: mockProvider(), feather: 8 });
    const { rect, inside } = prep.frame;
    const red = Buffer.alloc(rect.width * rect.height * 3);
    for (let i = 0; i < red.length; i += 3) red[i] = 255;
    const attempt = blendFrame(prep, red, prep.alpha);
    const at = (x: number, y: number) => {
      const i = ((y - rect.y) * rect.width + x - rect.x) * 3;
      return [attempt[i], attempt[i + 1], attempt[i + 2]];
    };
    expect(at(400, 250)).toEqual([255, 0, 0]);
    expect(at(inside.x + 2, inside.y + 2)).toEqual([128, 128, 128]);
    expect(at(320, 180)).toEqual([128, 128, 128]);

    const step = await revise(prep, red, prep.alpha, prep.insideMask, '- Smaller.');
    expect(step.prompt).toContain('FIX:\n- Smaller.');
    expect(step.images).toHaveLength(2);
    const seen = await sharp(step.images[0]!.data).raw().toBuffer({ resolveWithObject: true });
    const cx = Math.round(((400 - rect.x) / rect.width) * seen.info.width);
    const cy = Math.round(((250 - rect.y) / rect.height) * seen.info.height);
    const i = (cy * seen.info.width + cx) * 3;
    expect(seen.data[i]).toBeGreaterThan(200);
    expect(seen.data[i + 1]).toBeLessThan(60);

    const forCritic = await criticImages(prep, attempt, prep.insideMask);
    expect(forCritic).toHaveLength(3);
  });
});

describe('Шаги с критиком', () => {
  it('первый шаг — с исходного куска, следующий исправляет прежний по замечаниям; последний критик тоже смотрит', { timeout: 30_000 }, async () => {
    const { s, provider, director, create } = await session();
    const id = create(3);
    const job = jobOf(s, id);
    await until(() => job().status === 'done' && !job().chain);
    expect(director.calls).toHaveLength(1);
    expect(provider.calls).toHaveLength(3);
    expect(director.reviews).toHaveLength(3);
    expect(s.state().generations.session).toBe(3);

    const [v0, v1, v2] = job().variants;
    expect(v0).toMatchObject({ status: 'done', base: undefined, fixes: undefined });
    expect(v1).toMatchObject({ status: 'done', base: 0 });
    expect(v1!.fixes).toMatch(/critic #1/);
    expect(v2).toMatchObject({ status: 'done', base: 1 });
    expect(v2!.fixes).toMatch(/critic #2/);
    expect(v2!.critique).toMatchObject({ done: false });
    expect(v2!.critique!.text).toMatch(/critic #3/);
    expect(job().selected).toBe(2);
    expect(job().error).toBeUndefined();

    // Модель первого шага видит исходный кусок, следующего — кусок с прежней попыткой и замечания
    expect(provider.calls[0]!.prompt).not.toContain('FIX');
    expect(provider.calls[1]!.prompt).toContain('FIX:\n- Make the change bolder (mock critic #1).');
    expect(provider.calls[1]!.images[0]!.data.equals(provider.calls[0]!.images[0]!.data)).toBe(false);
    // Критик видит кусок до, с подсветкой, после и весь холст; знает, что шаг должен был исправить
    expect(director.reviews[0]).toMatchObject({ mustFix: false, overview: true, fixes: undefined });
    expect(director.reviews[0]!.images).toHaveLength(4);
    expect(director.reviews[1]!.fixes).toBe(v1!.fixes);
    expect(director.reviews[1]!.directed).toBe(job().directed);

    // Ещё шаг от выбранного: прежний ответ критика с замечаниями годится, нового вызова нет
    await s.moreVariants(id, 1);
    expect(director.reviews).toHaveLength(4);
    expect(job().variants[3]).toMatchObject({ base: 2, status: 'done' });

    // Каждый шаг — версия слоя, на холсте — последний: вне маски холст не тронут
    const layer = s.state().objects[0]!;
    expect(layer.versions).toEqual(job().variants.map((v) => v.patch));
    expect(layer.current).toBe(job().variants[3]!.patch);
    const { data, width } = s.doc!.raw();
    const px = (x: number, y: number) => [...data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
    expect(px(290, 190)).toEqual(BG);
    expect(px(420, 290)).not.toEqual(BG);
    // Ластик по маске версии открывает исходник
    await s.editPatchMask(layer.current!, [{ kind: 'rect', x: 300, y: 200, width: 40, height: 40, erase: true }]);
    expect(px(310, 210)).toEqual(BG);

    // Ещё шаги версии с той же задачей: критик сначала смотрит её саму, первый шаг исправляет её
    const again = s.patchVariants(layer.current!, { variants: 1, model: 'flash', size: 'auto' });
    const redo = jobOf(s, again);
    await until(() => redo().status === 'done' && !redo().chain);
    expect(redo().variants[0]).toMatchObject({ current: true });
    expect(redo().variants[1]).toMatchObject({ base: 0, status: 'done' });
    expect(redo().variants[1]!.fixes).toMatch(/critic #5/);
    expect(director.calls).toHaveLength(1);
    expect(s.state().objects[0]!.versions).toHaveLength(5);
  });

  it('критик доволен — шаги кончаются раньше; ещё шаги от выбранного: критик обязан найти, что улучшить', { timeout: 30_000 }, async () => {
    const { s, provider, director, create } = await session({ doneAt: 2 });
    const id = create(4);
    const job = jobOf(s, id);
    await until(() => job().status === 'done' && !job().chain);
    expect(provider.calls).toHaveLength(2);
    expect(job().variants[1]!.critique).toMatchObject({ done: true });

    // От «готового» шага — критик заново и с замечаниями
    await s.moreVariants(id, 1);
    expect(director.reviews[2]!.mustFix).toBe(true);
    expect(job().variants[2]).toMatchObject({ base: 1 });
    expect(job().variants[2]!.fixes).toMatch(/critic #3/);
    expect(provider.calls).toHaveLength(3);

    // От выбранной руками первой версии — её замечания уже есть, критика заново не зовут
    await s.setCurrent(s.state().objects[0]!.id, job().variants[0]!.patch!);
    const reviews = director.reviews.length;
    await s.moreVariants(id, 1);
    expect(job().variants[3]).toMatchObject({ base: 0, fixes: job().variants[0]!.critique!.text });
    expect(director.reviews).toHaveLength(reviews + 1);
    expect(job().selected).toBe(3);

    // Поправленная задача — директор заново, шаги с исходного куска
    await s.moreVariants(id, 1, { prompt: 'парусник' });
    expect(director.calls).toHaveLength(2);
    expect(job().variants[4]).toMatchObject({ prompt: 'парусник', base: undefined, fixes: undefined });
    expect(provider.calls.at(-1)!.prompt).not.toContain('FIX');

    // Без директора — снова варианты разом
    await s.moreVariants(id, 2, { director: false });
    expect(job().variants.slice(5).map((v) => v.base)).toEqual([undefined, undefined]);
    expect(provider.calls).toHaveLength(7);
  });

  it('ошибка критика: готовые шаги остаются, причина видна, генерации дальше не тратятся', { timeout: 30_000 }, async () => {
    const { s, provider, create } = await session();
    (s as unknown as { directorImpl: PromptDirector }).directorImpl = {
      ...mockDirector(),
      review: () => Promise.reject(new Error('исчерпан лимит')),
    };
    const id = create(3);
    const job = jobOf(s, id);
    await until(() => job().status === 'done' && !job().chain);
    expect(provider.calls).toHaveLength(1);
    expect(job().variants).toHaveLength(1);
    expect(job().error).toBe('Критик: исчерпан лимит');
    expect(job().reviewing).toBe(false);
  });

  it('«Остановить»: идущий шаг отменяется и пропадает, готовые остаются, ещё шаги потом можно', { timeout: 30_000 }, async () => {
    const { s, provider, create } = await session({ delayMs: 400 });
    const id = create(4);
    const job = jobOf(s, id);
    await until(() => job().status === 'done' && provider.calls.length === 2);
    s.stop(id);
    await until(() => !job().chain);
    expect(job()).toMatchObject({ status: 'done', error: undefined });
    expect(job().variants).toHaveLength(1);
    expect(provider.calls).toHaveLength(2);

    await s.moreVariants(id, 1);
    expect(job().variants).toHaveLength(2);
    expect(job().variants[1]).toMatchObject({ status: 'done', base: 0 });
  });
});

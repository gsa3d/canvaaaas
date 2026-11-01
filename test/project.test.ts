import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { featherAlpha } from '../src/core/mask.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { RecentFiles } from '../src/core/recent.ts';
import { noKeys } from '../src/core/secrets.ts';
import { Session, type Host } from '../src/server/session.ts';

const W = 900;
const H = 700;
let dir: string;

function pattern(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return raw;
}

/** Слой как после принятия: шум «ответа модели» на весь прямоугольник, альфа — маска с растушёвкой */
function patch(id: string, x: number, y: number, w: number, h: number, feather: number) {
  const mask = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) mask.fill(255, r * w, r * w + Math.round(w * 0.6));
  const alpha = featherAlpha(mask, w, h, feather);
  const layer = Buffer.alloc(w * h * 4);
  const noise = pattern(w, h);
  for (let i = 0; i < w * h; i++) layer.set([noise[i * 3]!, noise[i * 3 + 1]!, 40, Math.round(alpha[i]! * 255)], i * 4);
  return { id, rect: { x, y, width: w, height: h }, layer, mask, feather, prompt: `правка ${id}`, jobId: `job-${id}`, variant: 1, createdAt: '2026-10-23T10:00:00.000Z' };
}

function fakeHost(answers: { save?: string[]; ask?: number[] }) {
  const asked: string[] = [];
  const defaults: string[] = [];
  const host: Host = {
    chooseOpen: async () => null,
    chooseSave: async (defaultPath) => {
      defaults.push(defaultPath);
      return answers.save?.shift() ?? null;
    },
    ask: async ({ message }) => {
      asked.push(message);
      return answers.ask?.shift() ?? 0;
    },
  };
  return { host, asked, defaults };
}

async function session(host?: Host): Promise<Session> {
  return new Session('mock', noKeys(), { host, recent: await RecentFiles.load(join(dir, `data-${Math.random()}`)) });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvaaaas-project-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Проект .caaa', () => {
  it('картинка со слоями: «Сохранить» предлагает .caaa; после открытия холст, слои, маски и стиль те же', async () => {
    const png = join(dir, 'art.png');
    await sharp(pattern(W, H), { raw: { width: W, height: H, channels: 3 } }).png().toFile(png);
    const target = join(dir, 'art.caaa');
    const { host, asked, defaults } = fakeHost({ save: [target], ask: [0] });
    const s = await session(host);
    await s.openPath(png);
    const doc = s.doc!;
    doc.addPatch(patch('a', 100, 80, 300, 240, 16));
    doc.addPatch(patch('b', 250, 200, 400, 300, 0));
    doc.addPatch(patch('c', 500, 50, 200, 200, 8));
    doc.togglePatch('c');
    await s.editPatchMask('a', [{ kind: 'stroke', points: [[150, 150], [300, 200]], size: 50, softness: 0.6, erase: true }]);
    s.setStyle('акварель');
    const pngBefore = await readFile(png);

    expect(await s.save()).toBe(target);
    expect(asked).toEqual(['Сохранить слои?']);
    expect(defaults).toEqual([join(dir, 'art.caaa')]);
    expect(await readFile(png)).toEqual(pngBefore);
    expect(s.state().doc).toMatchObject({ name: 'art.caaa', path: target, project: true, dirty: false });

    // Повторное «Сохранить» пишет в тот же .caaa без вопросов
    doc.togglePatch('b');
    expect(s.dirty).toBe(true);
    expect(await s.save()).toBe(target);
    expect(asked).toHaveLength(1);
    doc.togglePatch('b');
    await s.save();

    const t = await session(fakeHost({}).host);
    await t.openPath(target);
    const back = t.doc!;
    expect(back.composite.equals(doc.composite)).toBe(true);
    expect(back.base.equals(doc.base)).toBe(true);
    expect(back.style).toBe('акварель');
    expect(back.canUndo).toBe(false);
    expect(t.dirty).toBe(false);
    expect(back.patches.map((p) => [p.id, p.active, p.feather, p.prompt, p.variant])).toEqual(
      doc.patches.map((p) => [p.id, p.active, p.feather, p.prompt, p.variant]),
    );
    for (const [i, p] of back.patches.entries()) {
      expect(p.layer.equals(doc.patches[i]!.layer), p.id).toBe(true);
      expect(Buffer.from(p.mask).equals(Buffer.from(doc.patches[i]!.mask)), p.id).toBe(true);
    }
    expect(t.state().recent[0]?.path).toBe(target);

    // Слои после открытия живые: скрытый показывается, маску можно править, отмена работает
    back.togglePatch('c');
    doc.togglePatch('c');
    expect(back.composite.equals(doc.composite)).toBe(true);
    await t.editPatchMask('b', [{ kind: 'rect', x: 250, y: 200, width: 400, height: 300, erase: true }]);
    await s.editPatchMask('b', [{ kind: 'rect', x: 250, y: 200, width: 400, height: 300, erase: true }]);
    expect(back.composite.equals(doc.composite)).toBe(true);
    expect(t.dirty).toBe(true);
    await t.undo();
    await t.undo();
    expect(back.canUndo).toBe(false);
    expect(t.dirty).toBe(false);

    // Стиль записывается в проект, поэтому его правка — несохранённое изменение
    t.setStyle('гуашь');
    expect(t.dirty).toBe(true);
  });

  it('«Записать картинкой» сливает слои и больше не спрашивает; «Сохранить как» по умолчанию предлагает .caaa, пока слои не сливали', async () => {
    const png = join(dir, 'flat.png');
    await sharp(pattern(W, H), { raw: { width: W, height: H, channels: 3 } }).png().toFile(png);
    const { host, asked, defaults } = fakeHost({ ask: [1] });
    const s = await session(host);
    await s.openPath(png);
    s.doc!.addPatch(patch('a', 100, 80, 300, 240, 16));
    expect(await s.saveAs()).toBeNull();
    expect(defaults).toEqual([join(dir, 'flat.caaa')]);

    expect(await s.save()).toBe(png);
    s.doc!.addPatch(patch('b', 400, 300, 200, 200, 0));
    expect(await s.save()).toBe(png);
    expect(asked).toEqual(['Сохранить слои?']);
    const saved = await sharp(png).removeAlpha().raw().toBuffer();
    expect(saved.equals(s.doc!.composite)).toBe(true);
    expect(await s.saveAs()).toBeNull();
    expect(defaults[1]).toBe(join(dir, 'flat.png'));
  });

  it('новый холст без слоёв сохраняется картинкой без вопроса; экспорт не меняет файл документа', async () => {
    const caaa = join(dir, 'new.caaa');
    const exported = join(dir, 'new-export.jpg');
    const { host, asked } = fakeHost({ save: [caaa, exported] });
    const s = await session(host);
    await s.newDocument(320, 200, [250, 250, 250], 300);
    s.doc!.addPatch(patch('a', 10, 10, 100, 100, 0));
    // Слои есть, а файла нет: вопрос «Сохранить слои?», ответ по умолчанию — .caaa
    expect(await s.save()).toBe(caaa);
    expect(asked).toEqual(['Сохранить слои?']);
    expect(await s.exportImage()).toBe(exported);
    expect((await sharp(exported).metadata()).format).toBe('jpeg');
    expect(s.state().doc).toMatchObject({ name: 'new.caaa', path: caaa, project: true });

    const t = await session();
    await t.openPath(caaa);
    expect(t.doc!.composite.equals(s.doc!.composite)).toBe(true);
    // Разрешение для печати живёт в проекте и попадает в картинку при экспорте
    expect((await sharp(exported).metadata()).density).toBe(300);
  });

  it('проект из браузера открывается по содержимому, испорченный — с понятной ошибкой', async () => {
    const s = await session();
    await s.newDocument(64, 48, [0, 0, 0]);
    s.doc!.addPatch(patch('a', 4, 4, 32, 32, 0));
    const data = await encodeProject(s.doc!);

    const t = await session();
    await t.openDocument(data, 'из-браузера.caaa');
    expect(t.doc!.composite.equals(s.doc!.composite)).toBe(true);
    expect(t.doc!.patches).toHaveLength(1);

    await expect(openProject(Buffer.from('not a project at all'), 'x.caaa')).rejects.toThrow(/не проект canvaaaas/);
    await expect(openProject(data.subarray(0, data.length - 50), 'x.caaa')).rejects.toThrow(/обрезан/);
    const broken = join(dir, 'broken.caaa');
    await writeFile(broken, data.subarray(0, 40));
    await expect(t.openPath(broken)).rejects.toThrow(/Не открыть «broken.caaa»/);
  });
});

describe('Проект 1 — в слои с версиями', () => {
  it('каждая правка — слоем с ней одной текущей версией, скрытая — скрытым слоем; холст тот же', async () => {
    const s = new Session('mock', noKeys());
    await s.openDocument(await sharp(pattern(W, H), { raw: { width: W, height: H, channels: 3 } }).png().toBuffer(), 'a.png');
    const doc = s.doc!;
    doc.addPatch({ ...patch('p1', 100, 100, 300, 200, 12), prompt: 'кот на крыше' });
    doc.addPatch({ ...patch('p2', 250, 150, 300, 300, 0), prompt: 'пёс' });
    doc.addPatch(patch('p3', 500, 300, 200, 200, 8));
    doc.togglePatch('p3');
    // Как писал проект 1: та же раскладка, только номер версии в описании
    const file = await encodeProject(doc);
    const start = 8 + 4;
    const length = file.readUInt32BE(8);
    const manifest = JSON.parse(file.toString('utf8', start, start + length));
    manifest.version = 1;
    const json = Buffer.from(JSON.stringify(manifest), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(json.length);
    const old = Buffer.concat([file.subarray(0, 8), head, json, file.subarray(start + length)]);

    const back = (await openProject(old, 'old.caaa')).doc;
    expect(back.objects.map((o) => [o.name, o.current, o.hidden ?? false])).toEqual([
      ['кот на крыше', 'p1', false],
      ['пёс', 'p2', false],
      ['правка p3', 'p3', true],
    ]);
    expect(back.patches.map((p) => p.object)).toEqual(back.objects.map((o) => o.id));
    expect(back.composite.equals(doc.composite)).toBe(true);
  });
});

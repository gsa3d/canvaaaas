import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inspectImage } from '../src/core/image-file.ts';
import { RECENT_LIMIT, RecentFiles } from '../src/core/recent.ts';
import { envOnlyStore } from '../src/core/secrets.ts';
import { Session, type Host } from '../src/server/session.ts';

const W = 1200;
const H = 900;
let dir: string;

function pattern(width: number, height: number): Buffer {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return raw;
}

async function png(path: string, raw = pattern(W, H)): Promise<Buffer> {
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).png().toFile(path);
  return raw;
}

function decode(path: string): Promise<Buffer> {
  return sharp(path).removeAlpha().raw().toBuffer();
}

/** Окна приложения понарошку: ответы заданы заранее, вопросы записываются */
function fakeHost(answers: { save?: string | null; ask?: number[] } = {}) {
  const asked: string[] = [];
  const saveDialogs: { defaultPath: string; message?: string }[] = [];
  const host: Host = {
    chooseOpen: async () => null,
    chooseSave: async (defaultPath, message) => {
      saveDialogs.push({ defaultPath, message });
      return answers.save ?? null;
    },
    ask: async ({ message }) => {
      asked.push(message);
      return answers.ask?.shift() ?? 0;
    },
  };
  return { host, asked, saveDialogs };
}

async function session(host?: Host): Promise<Session> {
  return new Session('mock', envOnlyStore(), { host, recent: await RecentFiles.load(join(dir, `data-${Math.random()}`)) });
}

/** Правка прямо в документ — как будто вариант приняли */
function addPatch(s: Session, x = 300, y = 200, size = 256): void {
  const layer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) layer.set([250, 40, 40, 255], i * 4);
  s.doc!.addPatch({ id: `p${x}`, rect: { x, y, width: size, height: size }, layer, prompt: 'p', jobId: 'j', variant: 0, createdAt: '' });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvaaaas-save-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('inspectImage', () => {
  it('обычный PNG в sRGB можно перезаписать, а прозрачность, 16 бит, P3 и TIFF — нет', async () => {
    const raw = pattern(W, H);
    const img = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } });
    await img().png().toFile(join(dir, 'plain.png'));
    await img().ensureAlpha().png().toFile(join(dir, 'opaque-alpha.png'));
    await img().withMetadata().png().toFile(join(dir, 'srgb.png'));
    const holes = await img().ensureAlpha().raw().toBuffer();
    holes[3] = 0;
    await sharp(holes, { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(dir, 'alpha.png'));
    await img().toColourspace('rgb16').png().toFile(join(dir, 'deep.png'));
    await img().withIccProfile('p3').png().toFile(join(dir, 'p3.png'));
    await img().tiff().toFile(join(dir, 'plain.tif'));

    for (const ok of ['plain.png', 'opaque-alpha.png', 'srgb.png']) expect((await inspectImage(join(dir, ok))).blocker, ok).toBeUndefined();
    expect((await inspectImage(join(dir, 'alpha.png'))).blocker).toMatch(/прозрачн/);
    expect((await inspectImage(join(dir, 'deep.png'))).blocker).toMatch(/8 бит/);
    expect((await inspectImage(join(dir, 'p3.png'))).blocker).toMatch(/P3/);
    expect((await inspectImage(join(dir, 'plain.tif'))).blocker).toMatch(/TIFF/);
  });
});

describe('Сохранить', () => {
  it('перезаписывает открытый PNG: вне правки пиксели побайтно те же, документ больше не «изменён»', async () => {
    const path = join(dir, 'art.png');
    const original = await png(path);
    const s = await session(fakeHost().host);
    await s.openPath(path);
    addPatch(s);
    expect(s.dirty).toBe(true);

    expect(await s.save()).toBe(path);
    expect(s.dirty).toBe(false);
    const saved = await decode(path);
    let outside = 0;
    let inside = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const same = saved[i] === original[i] && saved[i + 1] === original[i + 1] && saved[i + 2] === original[i + 2];
        const patched = x >= 300 && x < 556 && y >= 200 && y < 456;
        if (patched) inside += saved[i] === 250 && saved[i + 1] === 40 ? 1 : 0;
        else if (!same) outside++;
      }
    }
    expect(outside).toBe(0);
    expect(inside).toBe(256 * 256);
    expect(s.state().recent[0]?.path).toBe(path);
  });

  it('«изменён» — по содержимому: отмена до сохранённого состояния снимает метку, выключенная правка ставит', async () => {
    const path = join(dir, 'undo.png');
    await png(path);
    const s = await session(fakeHost().host);
    await s.openPath(path);
    addPatch(s);
    s.doc!.undo();
    expect(s.dirty).toBe(false);
    s.doc!.redo();
    expect(s.dirty).toBe(true);

    await s.save();
    s.doc!.togglePatch('p300');
    expect(s.dirty).toBe(true);
    s.doc!.togglePatch('p300');
    expect(s.dirty).toBe(false);
  });

  it('файл, который не перезаписать без потерь, сохраняет под другим именем и не трогает исходник', async () => {
    const path = join(dir, 'transparent.png');
    const holes = await sharp(pattern(W, H), { raw: { width: W, height: H, channels: 3 } }).ensureAlpha().raw().toBuffer();
    holes[3] = 0;
    await sharp(holes, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path);
    const before = await readFile(path);
    const target = join(dir, 'transparent-copy.jpg');
    const { host, saveDialogs } = fakeHost({ save: target });
    const s = await session(host);
    await s.openPath(path);
    addPatch(s);

    expect(await s.save()).toBe(target);
    expect(saveDialogs[0]?.defaultPath).toBe(join(dir, 'transparent-canvaaaas.png'));
    expect(saveDialogs[0]?.message).toMatch(/прозрачн/);
    expect((await readFile(path)).equals(before)).toBe(true);
    expect((await sharp(target).metadata()).format).toBe('jpeg');
    expect(s.state().doc?.name).toBe('transparent-copy.jpg');
    // Теперь «Сохранить» пишет в новый файл без вопросов
    addPatch(s, 600);
    expect(await s.save()).toBe(target);
    expect(saveDialogs).toHaveLength(1);
  });

  it('спрашивает, если файл изменила другая программа; «Отмена» ничего не пишет', async () => {
    const path = join(dir, 'touched.png');
    await png(path);
    const { host, asked } = fakeHost({ ask: [2] });
    const s = await session(host);
    await s.openPath(path);
    addPatch(s);
    await writeFile(path, await readFile(path));
    await utimes(path, new Date(), new Date(Date.now() + 5000));
    const before = await readFile(path);

    expect(await s.save()).toBeNull();
    expect(asked[0]).toMatch(/изменила другая программа/);
    expect((await readFile(path)).equals(before)).toBe(true);
    expect(s.dirty).toBe(true);
  });

  it('новый холст сохраняет через «Сохранить как» с dpi пресета', async () => {
    const target = join(dir, 'a4.png');
    const { host, saveDialogs } = fakeHost({ save: target });
    const s = await session(host);
    await s.newDocument(248, 351, [255, 255, 255], 300);
    expect(await s.save()).toBe(target);
    expect(saveDialogs[0]?.defaultPath).toBe('Холст 248×351.png');
    expect((await sharp(target).metadata()).density).toBe(300);
  });
});

describe('Закрытие документа', () => {
  it('с несохранёнными правками спрашивает; «Не сохранять» закрывает, «Отмена» оставляет', async () => {
    const path = join(dir, 'close.png');
    await png(path);
    const { host, asked } = fakeHost({ ask: [2, 1] });
    const s = await session(host);
    await s.openPath(path);
    expect(await s.confirmClose()).toBe(true);
    expect(asked).toHaveLength(0);

    addPatch(s);
    const before = await readFile(path);
    expect(await s.newDocument(64, 64, [0, 0, 0])).toBe(false);
    expect(s.state().doc?.name).toBe('close.png');
    expect(await s.newDocument(64, 64, [0, 0, 0])).toBe(true);
    expect(asked).toEqual(['Сохранить изменения в «close.png»?', 'Сохранить изменения в «close.png»?']);
    expect((await readFile(path)).equals(before)).toBe(true);
  });
});

describe('RecentFiles', () => {
  it('поднимает повторно открытый файл наверх, держит не больше лимита и переживает перезапуск', async () => {
    const data = join(dir, 'recent-data');
    const recent = await RecentFiles.load(data);
    const thumb = Buffer.from('jpeg');
    for (let i = 0; i < RECENT_LIMIT + 3; i++) await recent.add({ path: `/pics/${i}.png`, name: `${i}.png`, width: 10, height: 10 }, thumb);
    await recent.add({ path: '/pics/5.png', name: '5.png', width: 10, height: 10 }, thumb);
    const list = recent.list();
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]?.path).toBe('/pics/5.png');
    expect(list.filter((e) => e.path === '/pics/5.png')).toHaveLength(1);
    expect(list.some((e) => e.path === '/pics/0.png')).toBe(false);

    const again = await RecentFiles.load(data);
    expect(again.list().map((e) => e.path)).toEqual(list.map((e) => e.path));
    expect((await readFile(again.thumbPath(list[0]!.id))).toString()).toBe('jpeg');
    await again.clear();
    expect((await RecentFiles.load(data)).list()).toHaveLength(0);
  });
});

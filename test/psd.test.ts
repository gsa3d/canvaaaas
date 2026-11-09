import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeCanvas, readPsd, writePsdBuffer, type Layer, type Psd } from 'ag-psd';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CanvasDocument } from '../src/core/document.ts';
import { encodeProject, openProject } from '../src/core/project.ts';
import { exportPsd, importPsd, PsdCancelled } from '../src/core/psd.ts';
import type { PsdSummary } from '../src/core/psd-read.ts';
import { noKeys } from '../src/core/secrets.ts';
import { Session } from '../src/server/session.ts';

const W = 64;
const H = 48;
type Color = [number, number, number, number];
let dir: string;

function image(width: number, height: number, color: (x: number, y: number) => Color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  return { width, height, data, colorSpace: 'srgb' as const };
}

function at(left: number, top: number, width: number, height: number, color: (x: number, y: number) => Color): Pick<Layer, 'left' | 'top' | 'right' | 'bottom' | 'imageData'> {
  return { left, top, right: left + width, bottom: top + height, imageData: image(width, height, color) as unknown as ImageData };
}

const background = (x: number, y: number): Color => [x * 3, y * 5, 100, 255];

/** Снизу вверх: фон, полупрозрачный, группа со скрытым слоем и скрытая группа, Multiply, маска, обтравка, коррекция, вектор, слой за краем */
function fixture(): Psd {
  return {
    width: W,
    height: H,
    imageData: image(W, H, background) as unknown as ImageData,
    children: [
      { name: 'Фон', ...at(0, 0, W, H, background) },
      { name: 'Полупрозрачный', opacity: 0.5, ...at(4, 6, 10, 8, () => [200, 10, 20, 255]) },
      {
        name: 'Папка',
        children: [
          { name: 'Внутри', hidden: true, ...at(20, 20, 4, 4, () => [0, 255, 0, 255]) },
          { name: 'Скрытая группа', hidden: true, children: [{ name: 'Глубоко', ...at(26, 20, 4, 4, () => [0, 0, 255, 255]) }] },
        ],
      },
      { name: 'Линии', blendMode: 'multiply', ...at(30, 0, 8, 8, (x) => (x < 4 ? [0, 0, 0, 255] : [255, 255, 255, 255])) },
      {
        name: 'С маской',
        ...at(0, 30, 10, 10, () => [0, 0, 255, 255]),
        mask: { left: 0, top: 30, right: 10, bottom: 40, defaultColor: 0, imageData: image(10, 10, (x) => (x < 5 ? [0, 0, 0, 255] : [255, 255, 255, 255])) as unknown as ImageData },
      },
      { name: 'Основа', ...at(50, 30, 6, 6, () => [10, 10, 10, 255]) },
      { name: 'Обтравка', clipping: true, ...at(48, 28, 10, 10, () => [250, 250, 0, 255]) },
      { name: 'Коррекция', adjustment: { type: 'brightness/contrast', brightness: 10, contrast: 0, meanValue: 127 } },
      { name: 'Экран', blendMode: 'screen', ...at(40, 10, 2, 2, () => [1, 2, 3, 255]) },
      { name: 'За краем', ...at(60, 40, 10, 10, () => [5, 6, 7, 255]) },
    ],
  };
}

async function fixtureFile(name: string, psd: Psd = fixture(), psb = false): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, writePsdBuffer(psd, { generateThumbnail: false, psb }));
  return path;
}

function session(): Session {
  return new Session('mock', noKeys(), {});
}

async function opened(path: string): Promise<CanvasDocument> {
  const s = session();
  expect(await s.openPath(path)).toBe(true);
  return s.doc!;
}

function layer(doc: CanvasDocument, name: string) {
  const object = doc.objects.find((o) => o.name === name);
  if (!object) throw new Error(`нет слоя ${name}`);
  const patch = doc.patches.find((p) => p.object === object.id)!;
  return { object, patch };
}

function pixel(buf: Uint8Array, width: number, x: number, y: number, channels: number): number[] {
  return [...buf.subarray((y * width + x) * channels, (y * width + x + 1) * channels)];
}

beforeAll(async () => {
  // ag-psd в Node: холст ей не нужен, только заготовка картинки
  initializeCanvas(
    () => {
      throw new Error('холст не нужен');
    },
    (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as unknown as ImageData,
  );
  dir = await mkdtemp(join(tmpdir(), 'canvaaaas-psd-test-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('импорт PSD', () => {
  it('нижний непрозрачный слой становится исходником, остальные — слоями с пикселями', async () => {
    const doc = await opened(await fixtureFile('layers.psd'));
    expect(doc.width).toBe(W);
    expect(doc.height).toBe(H);
    expect(pixel(doc.base, W, 10, 7, 3)).toEqual([30, 35, 100]);
    expect(doc.objects.map((o) => o.name)).toEqual(['Полупрозрачный', 'Внутри', 'Глубоко', 'Линии', 'С маской', 'Основа', 'Обтравка', 'Экран', 'За краем']);
    expect(doc.objects.every((o) => o.imported)).toBe(true);
    expect(doc.patches.every((p) => p.lifted && p.feather === 0)).toBe(true);
  });

  it('непрозрачность — в альфу, цвет как был', async () => {
    const { patch } = layer(await opened(await fixtureFile('opacity.psd')), 'Полупрозрачный');
    expect(patch.rect).toEqual({ x: 4, y: 6, width: 10, height: 8 });
    expect(pixel(patch.layer, 10, 3, 3, 4)).toEqual([200, 10, 20, 128]);
    expect(patch.mask[0]).toBe(128);
  });

  it('группы и скрытые: вложенность как в файле', async () => {
    const doc = await opened(await fixtureFile('groups.psd'));
    const outer = doc.groups.find((g) => g.name === 'Папка')!;
    const inner = doc.groups.find((g) => g.name === 'Скрытая группа')!;
    expect(inner.group).toBe(outer.id);
    expect(inner.hidden).toBe(true);
    expect(layer(doc, 'Внутри').object).toMatchObject({ group: outer.id, hidden: true });
    expect(layer(doc, 'Глубоко').object.group).toBe(inner.id);
    expect(layer(doc, 'Глубоко').patch.active).toBe(false);
  });

  it('Multiply: белое прозрачно, чёрное как было, пустое обрезано', async () => {
    const { patch } = layer(await opened(await fixtureFile('multiply.psd')), 'Линии');
    expect(patch.rect).toEqual({ x: 30, y: 0, width: 4, height: 8 });
    expect(pixel(patch.layer, 4, 0, 0, 4)).toEqual([0, 0, 0, 255]);
  });

  it('растровая маска — в альфу', async () => {
    const { patch } = layer(await opened(await fixtureFile('mask.psd')), 'С маской');
    expect(patch.rect).toEqual({ x: 5, y: 30, width: 5, height: 10 });
    expect(pixel(patch.layer, 5, 0, 0, 4)).toEqual([0, 0, 255, 255]);
  });

  it('обтравка режется по основе', async () => {
    const { patch } = layer(await opened(await fixtureFile('clip.psd')), 'Обтравка');
    expect(patch.rect).toEqual({ x: 50, y: 30, width: 6, height: 6 });
  });

  it('слой за краем холста обрезается', async () => {
    const { patch, object } = layer(await opened(await fixtureFile('edge.psd')), 'За краем');
    expect(patch.rect).toEqual({ x: 60, y: 40, width: 4, height: 8 });
    expect(object.rect).toEqual(patch.rect);
  });

  it('итог импорта: что пропущено и что выглядит иначе', async () => {
    const s = session();
    await s.openPath(await fixtureFile('note.psd'));
    expect(s.state().notice?.text).toBe('PSD: 9 слоёв, пропущено 1: коррекция, режим наложения заменён у 1');
  });

  it('файл без слоёв — исходником', async () => {
    const path = await fixtureFile('flat.psd', { width: W, height: H, imageData: image(W, H, background) as unknown as ImageData });
    const doc = await opened(path);
    expect(doc.objects).toEqual([]);
    expect(pixel(doc.base, W, 10, 7, 3)).toEqual([30, 35, 100]);
  });

  it('PSB читается так же', async () => {
    const doc = await opened(await fixtureFile('layers.psb', fixture(), true));
    expect(doc.objects).toHaveLength(9);
    expect(pixel(layer(doc, 'Полупрозрачный').patch.layer, 10, 3, 3, 4)).toEqual([200, 10, 20, 128]);
  });

  it('до чтения пикселей известно, сколько памяти нужно; можно не брать скрытые и можно передумать', async () => {
    const path = await fixtureFile('confirm.psd');
    let summary: PsdSummary | null = null as PsdSummary | null;
    const visible = await importPsd(path, 'x', {
      confirm: async (s) => {
        summary = s;
        return 'visible';
      },
    });
    expect(summary!.layers).toBe(9);
    expect(summary!.hidden).toBe(2);
    expect(summary!.bytes).toBeGreaterThan(summary!.visibleBytes);
    expect(visible!.doc.objects.map((o) => o.name)).not.toContain('Глубоко');
    expect(visible!.doc.objects.map((o) => o.name)).not.toContain('Внутри');
    expect(await importPsd(path, 'x', { confirm: async () => null })).toBeNull();
  });

  it('отмена обрывает импорт', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(importPsd(await fixtureFile('cancel.psd'), 'x', { signal: abort.signal })).rejects.toBeInstanceOf(PsdCancelled);
  });

  it('CMYK не открывается, а объясняет почему', async () => {
    const head = Buffer.alloc(34);
    head.write('8BPS', 0, 'latin1');
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(4, 12);
    head.writeUInt32BE(16, 14);
    head.writeUInt32BE(16, 18);
    head.writeUInt16BE(8, 22);
    head.writeUInt16BE(4, 24);
    const path = join(dir, 'cmyk.psd');
    await writeFile(path, head);
    await expect(importPsd(path, 'x')).rejects.toThrow(/CMYK/);
  });

  it('открытый документ остаётся, если файл не прочитать', async () => {
    const s = session();
    await s.openPath(await fixtureFile('good.psd'));
    const before = s.doc;
    const path = join(dir, 'bad.psd');
    await writeFile(path, Buffer.from('8BPS не файл'));
    await expect(s.openPath(path)).rejects.toThrow();
    expect(s.doc).toBe(before);
  });

  it('слои из PSD помнят это и в проекте', async () => {
    const doc = await opened(await fixtureFile('project.psd'));
    const { doc: again } = await openProject(await encodeProject(doc), 'p.caaa');
    expect(again.objects.every((o) => o.imported)).toBe(true);
    expect(Buffer.compare(again.raw().data, doc.raw().data)).toBe(0);
  });
});

describe('файлы из настоящего Фотошопа', () => {
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  const names = ['Красный', 'В папке', 'Скрытый', 'Линии', 'С маской', 'Основа', 'Обтравка'];

  it('холст совпадает с тем, что нарисовал сам Фотошоп', async () => {
    const doc = await opened(join(fixtures, 'photoshop-raster.psd'));
    expect(doc.objects.map((o) => o.name)).toEqual(names);
    const truth = await sharp(join(fixtures, 'photoshop-raster.png')).removeAlpha().raw().toBuffer();
    expect(Buffer.compare(doc.raw().data, truth)).toBe(0);
  });

  it('текст, фигура и коррекция пропускаются, смарт-объект берётся', async () => {
    const s = session();
    await s.openPath(join(fixtures, 'photoshop.psd'));
    expect(s.doc!.objects.map((o) => o.name)).toEqual([...names, 'Смарт']);
    expect(s.state().notice?.text).toBe('PSD: 8 слоёв, пропущено 3: текст, вектор, коррекция');
  });

  it('16 бит: те же слои в 8 битах', async () => {
    const eight = await opened(join(fixtures, 'photoshop.psd'));
    const sixteen = await opened(join(fixtures, 'photoshop-16.psd'));
    expect(sixteen.objects.map((o) => [o.name, o.rect])).toEqual(eight.objects.map((o) => [o.name, o.rect]));
    expect(Buffer.compare(sixteen.base, eight.base)).toBe(0);
  });
});

describe('экспорт PSD', () => {
  it('слои, группы и картинка файла читаются другой программой', async () => {
    const doc = await opened(await fixtureFile('source.psd'));
    const path = join(dir, 'out.psd');
    expect(await exportPsd(doc, path)).toBe(path);
    const psd = readPsd(await readFile(path), { useImageData: true });
    expect([psd.width, psd.height]).toEqual([W, H]);
    expect(psd.children!.map((c) => c.name)).toEqual(['Фон', 'Полупрозрачный', 'Папка', 'Линии', 'С маской', 'Основа', 'Обтравка', 'Экран', 'За краем']);
    const folder = psd.children![2]!;
    expect(folder.children!.map((c) => c.name)).toEqual(['Внутри', 'Скрытая группа']);
    expect(folder.children![0]!.hidden).toBe(true);
    expect(folder.children![1]!.hidden).toBe(true);
    expect(folder.children![1]!.children!.map((c) => c.name)).toEqual(['Глубоко']);
    const half = psd.children![1]!;
    expect([half.left, half.top, half.right, half.bottom]).toEqual([4, 6, 14, 14]);
    expect([...half.imageData!.data.subarray(0, 4)]).toEqual([200, 10, 20, 128]);
    const composite = psd.imageData!;
    for (let i = 0; i < W * H; i++) expect([composite.data[i * 4], composite.data[i * 4 + 1], composite.data[i * 4 + 2]]).toEqual([...doc.raw().data.subarray(i * 3, i * 3 + 3)]);
  });

  it('туда и обратно: холст, слои и группы те же', async () => {
    const doc = await opened(await fixtureFile('round.psd'));
    const path = join(dir, 'round-out.psd');
    await exportPsd(doc, path);
    const again = await opened(path);
    expect(Buffer.compare(again.raw().data, doc.raw().data)).toBe(0);
    expect(Buffer.compare(again.base, doc.base)).toBe(0);
    expect(again.objects.map((o) => [o.name, o.hidden, o.rect])).toEqual(doc.objects.map((o) => [o.name, o.hidden, o.rect]));
    expect(again.groups.map((g) => g.name).sort()).toEqual(doc.groups.map((g) => g.name).sort());
  });

  it('видна текущая версия слоя, а файл документа не меняется', async () => {
    const s = session();
    await s.openPath(await fixtureFile('state.psd'));
    const before = s.state().doc?.path;
    const path = await s.writePsd(join(dir, 'state-out.psd'));
    expect(path).toBe(join(dir, 'state-out.psd'));
    expect(s.state().doc?.path).toBe(before);
    expect(s.state().activity).toBeNull();
  });

  it('PSB читается другой программой', async () => {
    const doc = await opened(await fixtureFile('for-psb.psd'));
    const path = join(dir, 'out.psb');
    expect(await exportPsd(doc, path)).toBe(path);
    const psd = readPsd(await readFile(path), { useImageData: true });
    expect(psd.children).toHaveLength(9);
    const again = await opened(path);
    expect(Buffer.compare(again.raw().data, doc.raw().data)).toBe(0);
  });

  it('отмена не оставляет файла', async () => {
    const doc = await opened(await fixtureFile('cancel-out.psd'));
    const abort = new AbortController();
    abort.abort();
    const path = join(dir, 'never.psd');
    await expect(exportPsd(doc, path, { signal: abort.signal })).rejects.toBeInstanceOf(PsdCancelled);
    await expect(readFile(path)).rejects.toThrow();
  });
});

// Маска по объекту сразу после генерации (флажок в форме) и у исходника слоя-копии.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { CanvasDocument } from '../src/core/document.ts';
import { area, overlap, trim } from '../src/core/objects.ts';
import type { Bitmap } from '../src/core/segment.ts';
import { noKeys } from '../src/core/secrets.ts';
import { mockProvider } from '../src/providers/mock.ts';
import type { GenerateRequest, GenerateResult, ImageProvider } from '../src/providers/types.ts';
import { Session } from '../src/server/session.ts';
import type { MaskShape } from '../src/shared/api.ts';

const W = 700;
const H = 500;
const BG = [235, 232, 225];
const DARK = [40, 40, 40];
/** Тёмный круг на светлом — его и находит маска подставной модели */
const DISK = { cx: 300, cy: 250, r: 70 };
/** Выделение куда шире круга */
const AREA: MaskShape = { kind: 'rect', x: 180, y: 140, width: 240, height: 220 };

const inDisk = (x: number, y: number) => Math.hypot(x - DISK.cx, y - DISK.cy) <= DISK.r;

function diskMask(): Bitmap {
  const rect = { x: DISK.cx - DISK.r, y: DISK.cy - DISK.r, width: 2 * DISK.r + 1, height: 2 * DISK.r + 1 };
  const mask = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) for (let x = 0; x < rect.width; x++) if (inDisk(rect.x + x, rect.y + y)) mask[y * rect.width + x] = 255;
  return { rect, mask };
}

const iou = (a: Bitmap, b: Bitmap) => {
  const i = overlap(a, b);
  return i / (area(a) + area(b) - i);
};

/** Модель, которая возвращает кусок как есть; delays — задержка каждого вызова по очереди */
function sameModel(delays: number[] = []): ImageProvider {
  const base = mockProvider();
  let n = 0;
  return Object.assign(Object.create(base) as ImageProvider, {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const wait = delays[n++] ?? 0;
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const { width, height } = base.outputSize(req.aspectRatio, req.imageSize);
      const image = await sharp(req.images[0]!.data).resize(width, height, { fit: 'fill' }).png().toBuffer();
      return { image, mimeType: 'image/png', model: 'mock', elapsedMs: wait };
    },
  });
}

async function setup(model: ImageProvider = sameModel()) {
  const s = new Session('mock', noKeys());
  await s.newDocument(W, H, BG as [number, number, number]);
  const doc = s.doc!;
  for (const buf of [doc.base, doc.composite]) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inDisk(x, y)) buf.set(DARK, (y * W + x) * 3);
  }
  doc.rev++;
  const inner = s as unknown as { providers: Map<string, ImageProvider>; mockMask: ImageProvider };
  inner.providers.set('flash:google', model);
  inner.mockMask = mockProvider({ mode: 'mask' });
  return { s, doc };
}

async function until(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 20_000) throw new Error('Не дождались');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const px = (buf: Buffer, x: number, y: number) => [...buf.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
const versions = (doc: CanvasDocument) => doc.patches.filter((p) => p.object && !p.lifted);

describe('Маска по объекту сразу после генерации', () => {
  it('версия и слой — по объекту, а не по выделению; вне маски — исходник; ⌘Z возвращает маску выделения', { timeout: 30_000 }, async () => {
    const { s, doc } = await setup();
    const id = s.createJob({ shapes: [AREA], prompt: 'круг', variants: 1, model: 'flash', size: 'auto', objectMask: true });
    const job = () => s.state().jobs.find((j) => j.id === id)!;
    await until(() => job().status === 'done');
    expect(job().variants[0]).toMatchObject({ status: 'done', masking: false });
    expect(job().variants[0]!.maskError).toBeUndefined();
    expect(s.state().generations.session).toBe(2);

    const [v] = versions(doc);
    expect(v!.feather).toBe(0);
    expect(iou(trim({ rect: v!.rect, mask: v!.mask })!, diskMask())).toBeGreaterThan(0.9);
    const layer = doc.object(v!.object!);
    expect(layer.current).toBe(v!.id);
    expect(iou(layer, diskMask())).toBeGreaterThan(0.9);
    // В выделении, но мимо круга — исходник
    expect(px(doc.composite, 190, 150)).toEqual(px(doc.base, 190, 150));

    await s.undo();
    const rect = { rect: { x: 180, y: 140, width: 240, height: 220 }, mask: new Uint8Array(240 * 220).fill(255) };
    expect(iou(doc.object(layer.id), rect)).toBeGreaterThan(0.95);
  });

  it('вариант, легший не на холст, не раздувает слой обратно до выделения', { timeout: 30_000 }, async () => {
    // Второй вариант готов, когда маска первого уже легла
    const { s, doc } = await setup(sameModel([0, 800]));
    const id = s.createJob({ shapes: [AREA], prompt: 'круг', variants: 2, model: 'flash', size: 'auto', objectMask: true });
    await until(() => s.state().jobs.find((j) => j.id === id)!.status === 'done');
    expect(s.state().generations.session).toBe(4);
    const [first, second] = versions(doc);
    const layer = doc.object(first!.object!);
    expect(layer.current).toBe(first!.id);
    expect(second!.feather).toBe(0);
    expect(iou(layer, diskMask())).toBeGreaterThan(0.9);
  });

  it('без флажка маска — выделение, генерация одна', { timeout: 30_000 }, async () => {
    const { s, doc } = await setup();
    const id = s.createJob({ shapes: [AREA], prompt: 'круг', variants: 1, model: 'flash', size: 'auto' });
    await until(() => s.state().jobs.find((j) => j.id === id)!.status === 'done');
    expect(s.state().generations.session).toBe(1);
    expect(versions(doc)[0]!.feather).toBeGreaterThan(0);
  });
});

describe('Маска исходника слоя-копии', () => {
  it('маска по объекту у копии: копия и слой — по объекту; ⌘Z возвращает', { timeout: 30_000 }, async () => {
    const { s, doc } = await setup();
    const id = await s.saveObject([AREA], 'круг');
    const lifted = doc.patches.find((p) => p.lifted && p.object === id)!;
    expect(iou(doc.object(id), diskMask())).toBeLessThan(0.5);

    await s.objectMask(lifted.id, 'flash');
    expect(lifted.feather).toBe(0);
    expect(iou(trim({ rect: lifted.rect, mask: lifted.mask })!, diskMask())).toBeGreaterThan(0.9);
    expect(iou(doc.object(id), diskMask())).toBeGreaterThan(0.9);

    await s.undo();
    expect(iou(doc.object(id), diskMask())).toBeLessThan(0.5);
  });

  it('кисть и ластик по маске копии: слой следует за ней', async () => {
    const { s, doc } = await setup();
    const id = await s.saveObject([AREA], 'круг');
    const lifted = doc.patches.find((p) => p.lifted && p.object === id)!;
    // Копия шире выделения на контур: ластик — с запасом
    await s.editPatchMask(lifted.id, [{ kind: 'rect', x: 170, y: 130, width: 130, height: 240, erase: true }]);
    const layer = doc.object(id);
    expect(layer.rect.x).toBeGreaterThanOrEqual(300);
    expect(px(doc.composite, 250, 250)).toEqual(px(doc.base, 250, 250));
  });
});

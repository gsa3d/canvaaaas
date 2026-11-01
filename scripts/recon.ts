// Разведка (шаг 0): базовая картинка, маски и контактные листы для сравнения подходов.
//   node scripts/recon.ts base --prompt "..." --ratio 4:3 --size 4K --out work/recon/base.png
//   node scripts/recon.ts mask --like work/recon/base.png --ellipse 2000,1500,300,200 --out work/recon/mask.png
//   node scripts/recon.ts sheet --work work/recon/a.work --image work/recon/base.png --result work/recon/a-v1.png --out work/recon/a-sheet.jpg
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { withLedger } from '../src/core/ledger.ts';
import { renderMask, type MaskShape } from '../src/core/mask-shapes.ts';
import { getKey } from '../src/core/secrets.ts';
import { geminiImage, type GeminiModel } from '../src/providers/gemini.ts';

const [command, ...rest] = process.argv.slice(2);
const { values: a } = parseArgs({
  args: rest,
  options: {
    prompt: { type: 'string' },
    ratio: { type: 'string', default: '4:3' },
    size: { type: 'string', default: '4K' },
    model: { type: 'string', default: 'flash' },
    out: { type: 'string' },
    like: { type: 'string' },
    ellipse: { type: 'string', multiple: true },
    rect: { type: 'string', multiple: true },
    work: { type: 'string' },
    image: { type: 'string' },
    result: { type: 'string' },
    variant: { type: 'string', default: '1' },
  },
});

function nums(s: string): number[] {
  return s.split(',').map(Number);
}

async function base(): Promise<void> {
  if (!a.prompt || !a.out) throw new Error('base: нужны --prompt и --out');
  const provider = withLedger(geminiImage({ service: 'laozhang', model: a.model as GeminiModel, apiKey: () => getKey('laozhang') }), 'recon-base');
  const res = await provider.generate({ prompt: a.prompt, images: [], aspectRatio: a.ratio, imageSize: a.size });
  await mkdir(dirname(a.out), { recursive: true });
  const png = await sharp(res.image).png().toBuffer();
  await writeFile(a.out, png);
  const meta = await sharp(png).metadata();
  console.log(`${res.model}: ${meta.width}×${meta.height} (${a.ratio} ${a.size}) за ${(res.elapsedMs / 1000).toFixed(1)} с → ${a.out}`);
  if (res.text) console.log(`Текст модели: ${res.text}`);
}

async function mask(): Promise<void> {
  if (!a.like || !a.out) throw new Error('mask: нужны --like и --out');
  const { width, height } = await sharp(a.like, { limitInputPixels: false }).metadata();
  const shapes: MaskShape[] = [
    ...(a.ellipse ?? []).map((s): MaskShape => {
      const [cx = 0, cy = 0, rx = 0, ry = 0] = nums(s);
      return { kind: 'ellipse', cx, cy, rx, ry };
    }),
    ...(a.rect ?? []).map((s): MaskShape => {
      const [x = 0, y = 0, w = 0, h = 0] = nums(s);
      return { kind: 'rect', x, y, width: w, height: h };
    }),
  ];
  await writeFile(a.out, await renderMask(width!, height!, shapes));
  console.log(`Маска ${width}×${height} → ${a.out}`);
}

// Слева направо: исходный кусок, что видела модель (подсветка), ответ модели, итог после вклейки
async function sheet(): Promise<void> {
  if (!a.work || !a.image || !a.result || !a.out) throw new Error('sheet: нужны --work, --image, --result и --out');
  const stats = JSON.parse(await readFile(`${a.work}/stats.json`, 'utf8')) as {
    frame: { inside: { x: number; y: number; width: number; height: number } };
  };
  const { inside } = stats.frame;
  const h = 640;
  const tile = (input: string | Buffer, region?: typeof inside) => {
    const img = sharp(input, { limitInputPixels: false });
    return (region ? img.extract({ left: region.x, top: region.y, width: region.width, height: region.height }) : img)
      .resize({ height: h })
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  };
  const guide = await readFile(`${a.work}/input-2.jpg`).catch(() => readFile(`${a.work}/input-1.jpg`));
  const genName = (await readdir(a.work)).find((f) => f.startsWith(`gen-v${a.variant}.`));
  if (!genName) throw new Error(`В ${a.work} нет ответа модели для варианта ${a.variant}`);
  const gen = await readFile(`${a.work}/${genName}`);
  const tiles = await Promise.all([tile(a.image, inside), tile(guide), tile(gen), tile(a.result, inside)]);
  const widths = await Promise.all(tiles.map(async (t) => (await sharp(t).metadata()).width!));
  const gap = 12;
  const total = widths.reduce((s, w) => s + w, 0) + gap * (tiles.length - 1);
  let left = 0;
  const layers = tiles.map((input, i) => {
    const layer = { input, left, top: 0 };
    left += widths[i]! + gap;
    return layer;
  });
  await sharp({ create: { width: total, height: h, channels: 3, background: '#202020' } })
    .composite(layers)
    .jpeg({ quality: 88 })
    .toFile(a.out);
  console.log(`Лист ${total}×${h} → ${a.out}`);
}

const commands: Record<string, () => Promise<void>> = { base, mask, sheet };
const run = command ? commands[command] : undefined;
if (!run) {
  console.error('Команды: base, mask, sheet');
  process.exit(1);
}
run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

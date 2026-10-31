// CLI правки области:
// node src/cli/edit-region.ts --image big.png --mask mask.png --prompt "..." --variants 2 --out result.png
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { prepareEdit, runVariants, type Guide } from '../core/edit-region.ts';
import { readLedger, withLedger } from '../core/ledger.ts';
import { getLaozhangKey } from '../core/secrets.ts';
import { chatgptCodex } from '../providers/chatgpt-codex.ts';
import { laozhangGemini, type GeminiModel } from '../providers/laozhang-gemini.ts';
import { mockProvider } from '../providers/mock.ts';
import type { ImageProvider } from '../providers/types.ts';
import { L, setLang } from '../shared/i18n.ts';
import { systemLang } from '../core/system-lang.ts';

setLang(systemLang());

const HELP = L(`Правка области большой картинки через Nano Banana или ChatGPT Images.

  --image <файл>        исходная картинка (обязательно)
  --mask <файл>         маска того же размера: белое — перерисовать (обязательно)
  --prompt <текст>      что сделать с областью (обязательно)
  --out <файл.png>      куда сохранить результат (обязательно)
  --style <текст>       общий стиль документа
  --variants <N>        сколько вариантов (по умолчанию 2)
  --model flash|pro     Nano Banana 2 или Nano Banana Pro (по умолчанию flash)
  --size auto|1K|2K|4K  разрешение ответа Nano Banana (по умолчанию auto); ChatGPT выбирает его сам
  --context <доля>      запас контекста вокруг выделения (по умолчанию 0.3)
  --context-min <px>    минимальный запас контекста (по умолчанию 128)
  --feather <px>        растушёвка внутрь маски (по умолчанию 24)
  --guide pair|overlay|blank  как показать модели область (по умолчанию pair)
  --work <папка>        куда сложить промежуточные файлы (по умолчанию <out>.work)
  --provider laozhang|chatgpt|mock
                        laozhang — Nano Banana по ключу (по умолчанию); chatgpt — ChatGPT Images
                        по подписке через Codex CLI, вошедший в ChatGPT; mock — без сети, для проверки
  --dry-run             только посчитать кусок и сохранить то, что уйдёт в модель
`, `Edit a region of a large image with Nano Banana or ChatGPT Images.

  --image <file>        source image (required)
  --mask <file>         mask of the same size: white = redraw (required)
  --prompt <text>       what to do with the region (required)
  --out <file.png>      where to save the result (required)
  --style <text>        document style
  --variants <N>        number of variants (default 2)
  --model flash|pro     Nano Banana 2 or Nano Banana Pro (default flash)
  --size auto|1K|2K|4K  Nano Banana output resolution (default auto); ChatGPT picks its own
  --context <ratio>     context margin around the selection (default 0.3)
  --context-min <px>    minimum context margin (default 128)
  --feather <px>        feather inside the mask (default 24)
  --guide pair|overlay|blank  how to show the region to the model (default pair)
  --work <dir>          where to put intermediate files (default <out>.work)
  --provider laozhang|chatgpt|mock
                        laozhang — Nano Banana with an API key (default); chatgpt — ChatGPT Images
                        on your ChatGPT subscription via a signed-in Codex CLI; mock — offline, for testing
  --dry-run             only compute the crop and save what would be sent to the model
`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values: a } = parseArgs({
    options: {
      image: { type: 'string' },
      mask: { type: 'string' },
      prompt: { type: 'string' },
      out: { type: 'string' },
      style: { type: 'string' },
      variants: { type: 'string', default: '2' },
      model: { type: 'string', default: 'flash' },
      size: { type: 'string', default: 'auto' },
      context: { type: 'string', default: '0.3' },
      'context-min': { type: 'string', default: '128' },
      feather: { type: 'string', default: '24' },
      guide: { type: 'string', default: 'pair' },
      work: { type: 'string' },
      provider: { type: 'string', default: 'laozhang' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (a.help) {
    console.log(HELP);
    return;
  }
  if (!a.image || !a.mask || !a.prompt || !a.out) fail(L(`Не хватает аргументов.\n\n${HELP}`, `Not enough arguments.\n\n${HELP}`));
  if (a.model !== 'flash' && a.model !== 'pro') fail(L('--model: flash или pro', '--model: flash or pro'));
  if (!['pair', 'overlay', 'blank'].includes(a.guide)) fail(L('--guide: pair, overlay или blank', '--guide: pair, overlay or blank'));
  const variants = Number(a.variants);
  if (!Number.isInteger(variants) || variants < 1 || variants > 8) fail(L('--variants: от 1 до 8', '--variants: 1 to 8'));

  let provider: ImageProvider;
  if (a.provider === 'mock') provider = mockProvider();
  else if (a.provider === 'laozhang')
    provider = withLedger(laozhangGemini({ model: a.model as GeminiModel, apiKey: getLaozhangKey }), 'edit-region');
  else if (a.provider === 'chatgpt') provider = withLedger(chatgptCodex(), 'edit-region');
  else fail(L('--provider: laozhang, chatgpt или mock', '--provider: laozhang, chatgpt or mock'));

  const outExt = extname(a.out) || '.png';
  const outBase = join(dirname(a.out), basename(a.out, outExt));
  const workDir = a.work ?? `${outBase}.work`;
  await mkdir(workDir, { recursive: true });

  const started = Date.now();
  const prep = await prepareEdit({
    image: a.image,
    mask: a.mask,
    prompt: a.prompt,
    style: a.style,
    provider,
    context: Number(a.context),
    contextMin: Number(a['context-min']),
    feather: Number(a.feather),
    imageSize: a.provider === 'chatgpt' ? 'auto' : a.size,
    guide: a.guide as Guide,
  });
  const { rect } = prep.frame;
  console.log(L(`Холст ${prep.canvas.width}×${prep.canvas.height}, выделение ${prep.bbox.width}×${prep.bbox.height} в (${prep.bbox.x}, ${prep.bbox.y})`, `Canvas ${prep.canvas.width}×${prep.canvas.height}, selection ${prep.bbox.width}×${prep.bbox.height} at (${prep.bbox.x}, ${prep.bbox.y})`));
  console.log(
    L(`Кусок ${rect.width}×${rect.height} в (${rect.x}, ${rect.y}), пропорции ${prep.frame.aspectRatio}, `, `Crop ${rect.width}×${rect.height} at (${rect.x}, ${rect.y}), aspect ${prep.frame.aspectRatio}, `) +
      L(`модель ${provider.model} отдаст ${prep.modelSize.width}×${prep.modelSize.height} (${prep.imageSize}), масштаб ×${prep.scale.toFixed(2)}`, `model ${provider.model} returns ${prep.modelSize.width}×${prep.modelSize.height} (${prep.imageSize}), scale ×${prep.scale.toFixed(2)}`),
  );
  for (const w of prep.warnings) console.log(`⚠ ${w}`);

  await writeFile(join(workDir, 'prompt.txt'), prep.prompt);
  await Promise.all(prep.images.map((img, i) => writeFile(join(workDir, `input-${i + 1}.jpg`), img.data)));
  if (a['dry-run']) {
    console.log(L(`Dry run: в модель ушло бы ${prep.images.length} картинки, они и промпт — в ${workDir}`, `Dry run: ${prep.images.length} images would go to the model; they and the prompt are in ${workDir}`));
    return;
  }

  const outcomes = await runVariants(prep, variants, { onProgress: (m) => console.log(m) });
  const summary = [];
  for (const o of outcomes) {
    const name = variants === 1 ? `${outBase}${outExt}` : `${outBase}-v${o.index + 1}${outExt}`;
    if (!o.ok) {
      summary.push({ variant: o.index + 1, error: o.error });
      continue;
    }
    const genExt = o.generated.mimeType === 'image/jpeg' ? 'jpg' : o.generated.mimeType.split('/')[1] ?? 'png';
    await writeFile(name, o.image);
    await writeFile(join(workDir, `gen-v${o.index + 1}.${genExt}`), o.generated.image);
    await writeFile(join(workDir, `patch-v${o.index + 1}.png`), o.patch);
    const s = o.stats;
    console.log(
      L(`Вариант ${o.index + 1} → ${name}: ответ ${s.modelOutput.width}×${s.modelOutput.height} за ${(o.generated.elapsedMs / 1000).toFixed(1)} с; `, `Variant ${o.index + 1} → ${name}: output ${s.modelOutput.width}×${s.modelOutput.height} in ${(o.generated.elapsedMs / 1000).toFixed(1)} s; `) +
        L(`внутри маски изменено ${s.insideChangedPct.toFixed(1)}%, вне маски ${s.outsideChangedPct.toFixed(1)}% пикселей (MAE ${s.outsideMae.toFixed(1)}, PSNR ${s.outsidePsnr.toFixed(1)} дБ), `, `changed ${s.insideChangedPct.toFixed(1)}% inside the mask, ${s.outsideChangedPct.toFixed(1)}% of pixels outside (MAE ${s.outsideMae.toFixed(1)}, PSNR ${s.outsidePsnr.toFixed(1)} dB), `) +
        L(`сдвиг ${s.shift.dx}, ${s.shift.dy} px`, `shift ${s.shift.dx}, ${s.shift.dy} px`),
    );
    summary.push({ variant: o.index + 1, file: name, elapsedMs: o.generated.elapsedMs, text: o.generated.text, patchRect: o.patchRect, ...s });
  }
  await writeFile(
    join(workDir, 'stats.json'),
    JSON.stringify(
      {
        provider: provider.id,
        model: provider.model,
        prompt: a.prompt,
        style: a.style,
        guide: a.guide,
        canvas: prep.canvas,
        bbox: prep.bbox,
        frame: prep.frame,
        imageSize: prep.imageSize,
        modelSize: prep.modelSize,
        scale: prep.scale,
        warnings: prep.warnings,
        totalMs: Date.now() - started,
        variants: summary,
      },
      null,
      2,
    ),
  );

  if (a.provider !== 'mock') {
    const today = new Date().toISOString().slice(0, 10);
    const n = (await readLedger()).filter((e) => e.at.startsWith(today)).length;
    console.log(L(`Генераций сегодня: ${n}`, `Generations today: ${n}`));
  }
  if (outcomes.some((o) => !o.ok)) process.exitCode = 1;
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));

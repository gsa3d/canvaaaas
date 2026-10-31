// Провайдер без сети — для тестов и проверки интерфейса.
// negate: первая входная картинка с инвертированными цветами (правка видна везде, в том числе вне маски);
// blob: поверх куска рисуется «объект» крупнее выделения, как это любит делать настоящая модель;
// mask: маска «объекта» — того, что на первой картинке тёмное: белым, остальное чёрным (как «Маска по объекту»).
import sharp from 'sharp';
import type { GenerateRequest, GenerateResult, ImageProvider, Size } from './types.ts';
import { L } from '../shared/i18n.ts';

export interface MockProvider extends ImageProvider {
  readonly calls: GenerateRequest[];
}

export interface MockOptions {
  mode?: 'negate' | 'blob' | 'mask';
  delayMs?: number;
}

export function mockProvider(opts: MockOptions = {}): MockProvider {
  const calls: GenerateRequest[] = [];
  const sizes: Record<string, Size> = {
    '1:1': { width: 1024, height: 1024 },
    '3:2': { width: 1264, height: 848 },
    '2:3': { width: 848, height: 1264 },
    '4:3': { width: 1200, height: 896 },
    '3:4': { width: 896, height: 1200 },
    '16:9': { width: 1376, height: 768 },
    '9:16': { width: 768, height: 1376 },
  };
  const factor: Record<string, number> = { '1K': 1, '2K': 2 };

  return {
    id: 'mock',
    model: 'mock',
    aspectRatios: Object.keys(sizes),
    imageSizes: Object.keys(factor),
    calls,

    outputSize(aspectRatio: string, imageSize: string): Size {
      const s = sizes[aspectRatio];
      const f = factor[imageSize];
      if (!s || !f) throw new Error(L(`mock: нет размера ${aspectRatio} ${imageSize}`, `mock: no size ${aspectRatio} ${imageSize}`));
      return { width: s.width * f, height: s.height * f };
    },

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      calls.push(req);
      const started = Date.now();
      const input = req.images[0];
      if (!input) throw new Error(L('mock: нет входной картинки', 'mock: no input image'));
      const { width, height } = this.outputSize(req.aspectRatio, req.imageSize);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (req.signal?.aborted) throw new Error(L('Генерация отменена', 'Generation canceled'));

      let image: Buffer;
      if (opts.mode === 'blob') {
        const hue = (calls.length * 67) % 360;
        const svg =
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
          `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width * 0.36}" ry="${height * 0.22}" fill="hsl(${hue},70%,50%)" stroke="#222" stroke-width="${width / 120}"/>` +
          `<line x1="${width * 0.5}" y1="${height * 0.5}" x2="${width * 0.5}" y2="${height * 0.08}" stroke="#222" stroke-width="${width / 80}"/>` +
          `</svg>`;
        image = await sharp(input.data)
          .resize(width, height, { fit: 'fill' })
          .composite([{ input: Buffer.from(svg) }])
          .png()
          .toBuffer();
      } else if (opts.mode === 'mask') {
        image = await sharp(input.data).resize(width, height, { fit: 'fill' }).greyscale().negate({ alpha: false }).threshold(156).png().toBuffer();
      } else {
        image = await sharp(input.data).resize(width, height, { fit: 'fill' }).negate({ alpha: false }).png().toBuffer();
      }
      return { image, mimeType: 'image/png', model: 'mock', elapsedMs: Date.now() - started };
    },
  };
}

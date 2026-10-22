// Провайдер для тестов: без сети, отдаёт первую входную картинку в размере ответа модели
// с инвертированными цветами — так правка видна везде, в том числе вне маски.
import sharp from 'sharp';
import type { GenerateRequest, GenerateResult, ImageProvider, Size } from './types.ts';

export interface MockProvider extends ImageProvider {
  readonly calls: GenerateRequest[];
}

export function mockProvider(): MockProvider {
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
      if (!s || !f) throw new Error(`mock: нет размера ${aspectRatio} ${imageSize}`);
      return { width: s.width * f, height: s.height * f };
    },

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      calls.push(req);
      const input = req.images[0];
      if (!input) throw new Error('mock: нет входной картинки');
      const { width, height } = this.outputSize(req.aspectRatio, req.imageSize);
      const image = await sharp(input.data).resize(width, height, { fit: 'fill' }).negate({ alpha: false }).png().toBuffer();
      return { image, mimeType: 'image/png', model: 'mock', elapsedMs: 0 };
    },
  };
}

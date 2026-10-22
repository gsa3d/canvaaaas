// Nano Banana (Gemini image) через прокси laozhang.ai — тот же запрос, что делает портал
// (imagegen/ajax.php): Google-формат generateContent, ключ в Authorization: Bearer.
import { ProviderError, type GenerateRequest, type GenerateResult, type ImageProvider, type Size } from './types.ts';

export const GEMINI_MODELS = {
  flash: 'gemini-3.1-flash-image-preview', // Nano Banana 2
  pro: 'gemini-3-pro-image-preview', // Nano Banana Pro
} as const;
export type GeminiModel = keyof typeof GEMINI_MODELS;

// Размеры ответа на 1K по документации Gemini; 2K и 4K — ровно вдвое и вчетверо больше
const SIZES_1K: Record<string, [number, number]> = {
  '1:1': [1024, 1024],
  '2:3': [848, 1264],
  '3:2': [1264, 848],
  '3:4': [896, 1200],
  '4:3': [1200, 896],
  '4:5': [928, 1152],
  '5:4': [1152, 928],
  '9:16': [768, 1376],
  '16:9': [1376, 768],
  '21:9': [1584, 672],
};
const SIZE_FACTOR: Record<string, number> = { '1K': 1, '2K': 2, '4K': 4 };

const DEFAULT_BASE_URL = 'https://api.laozhang.ai/v1beta/models';

export interface LaozhangGeminiOptions {
  model?: GeminiModel;
  /** Ключ запрашивается при каждом вызове и нигде не сохраняется */
  apiKey: () => Promise<string>;
  baseUrl?: string;
  timeoutMs?: number;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export function laozhangGemini(opts: LaozhangGeminiOptions): ImageProvider {
  const model = GEMINI_MODELS[opts.model ?? 'flash'];
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  return {
    id: 'laozhang-gemini',
    model,
    aspectRatios: Object.keys(SIZES_1K),
    imageSizes: Object.keys(SIZE_FACTOR),

    outputSize(aspectRatio: string, imageSize: string): Size {
      const base = SIZES_1K[aspectRatio];
      const factor = SIZE_FACTOR[imageSize];
      if (!base || !factor) throw new Error(`Nano Banana не поддерживает ${aspectRatio} ${imageSize}`);
      return { width: base[0] * factor, height: base[1] * factor };
    },

    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: req.prompt },
              ...req.images.map((img) => ({
                inline_data: { mime_type: img.mimeType, data: img.data.toString('base64') },
              })),
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: req.aspectRatio, imageSize: req.imageSize },
        },
      };

      const signals = [AbortSignal.timeout(timeoutMs)];
      if (req.signal) signals.push(req.signal);
      const started = Date.now();

      let res: Response;
      try {
        res = await fetch(`${baseUrl}/${model}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${await opts.apiKey()}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ProviderError(`Нет связи с laozhang.ai: ${reason}`, { retryable: true });
      }

      const raw = await res.text();
      let data: GeminiResponse = {};
      try {
        data = JSON.parse(raw) as GeminiResponse;
      } catch {
        // Не JSON: ниже вернём начало ответа как текст ошибки
      }

      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      const imagePart = parts.find((p) => p.inlineData?.data);
      const text = parts.map((p) => p.text ?? '').join('').trim() || undefined;

      if (!res.ok || !imagePart?.inlineData?.data) {
        const why =
          data.error?.message ??
          data.error?.status ??
          (data.promptFeedback?.blockReason && `запрос заблокирован: ${data.promptFeedback.blockReason}`) ??
          (candidate?.finishReason && `модель не вернула картинку (finishReason ${candidate.finishReason})`) ??
          (raw.slice(0, 300) || 'пустой ответ');
        throw new ProviderError(`laozhang.ai, HTTP ${res.status}: ${why}${text ? ` — «${text}»` : ''}`, {
          status: res.status,
          retryable: res.status === 429 || res.status >= 500,
        });
      }

      return {
        image: Buffer.from(imagePart.inlineData.data, 'base64'),
        mimeType: imagePart.inlineData.mimeType ?? 'image/png',
        model,
        elapsedMs: Date.now() - started,
        text,
      };
    },
  };
}

// Nano Banana (Gemini image): запрос Google generateContent — в Gemini API у Google по его ключу
// (заголовок x-goog-api-key) или в прокси laozhang.ai, тот же запрос, что делает портал (imagegen/ajax.php),
// ключ в Authorization: Bearer.
import { Agent, fetch } from 'undici';
import { ProviderError, type GenerateRequest, type GenerateResult, type ImageProvider, type Size } from './types.ts';
import { GEMINI_SERVICE_NAMES, type GeminiService } from '../shared/api.ts';
import { L } from '../shared/i18n.ts';

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

const SERVICES: Record<GeminiService, { baseUrl: string; auth: (key: string) => Record<string, string> }> = {
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models', auth: (key) => ({ 'x-goog-api-key': key }) },
  laozhang: { baseUrl: 'https://api.laozhang.ai/v1beta/models', auth: (key) => ({ Authorization: `Bearer ${key}` }) },
};

export interface GeminiImageOptions {
  service: GeminiService;
  model?: GeminiModel;
  /** Ключ запрашивается при каждом вызове и нигде не сохраняется */
  apiKey: () => Promise<string>;
  baseUrl?: string;
  timeoutMs?: number;
}

interface GeminiPart {
  text?: string;
  /** Промежуточная картинка, которую модель рисовала, пока думала, — не ответ */
  thought?: boolean;
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export function geminiImage(opts: GeminiImageOptions): ImageProvider {
  const model = GEMINI_MODELS[opts.model ?? 'flash'];
  const service = SERVICES[opts.service];
  const name = GEMINI_SERVICE_NAMES[opts.service];
  const baseUrl = opts.baseUrl ?? service.baseUrl;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  // 4K генерируется 4–5 минут, а встроенный fetch Node рвёт запрос через 300 с ожидания заголовков
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, connectTimeout: 15_000 });

  return {
    id: `${opts.service}-gemini`,
    model,
    aspectRatios: Object.keys(SIZES_1K),
    imageSizes: Object.keys(SIZE_FACTOR),

    outputSize(aspectRatio: string, imageSize: string): Size {
      const base = SIZES_1K[aspectRatio];
      const factor = SIZE_FACTOR[imageSize];
      if (!base || !factor) throw new Error(L(`Nano Banana не поддерживает ${aspectRatio} ${imageSize}`, `Nano Banana does not support ${aspectRatio} ${imageSize}`));
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

      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(`${baseUrl}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...service.auth(await opts.apiKey()) },
          body: JSON.stringify(body),
          signal: AbortSignal.any(signals),
          dispatcher,
        });
      } catch (err) {
        if (req.signal?.aborted) throw new ProviderError(L('Генерация отменена', 'Generation canceled'));
        // fetch прячет настоящую причину (сброс соединения, DNS, таймаут) в err.cause
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
        const code = cause && 'code' in cause ? ` ${String(cause.code)}` : '';
        const reason = cause ? `${cause.message}${code}` : err instanceof Error ? err.message : String(err);
        throw new ProviderError(L(`Нет связи с ${name}: ${reason}`, `Cannot reach ${name}: ${reason}`), { retryable: true });
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
      const imagePart = parts.find((p) => p.inlineData?.data && !p.thought);
      const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim() || undefined;

      if (!res.ok || !imagePart?.inlineData?.data) {
        const why =
          data.error?.message ??
          data.error?.status ??
          (data.promptFeedback?.blockReason && L(`запрос заблокирован: ${data.promptFeedback.blockReason}`, `request blocked: ${data.promptFeedback.blockReason}`)) ??
          (candidate?.finishReason && L(`модель не вернула картинку (finishReason ${candidate.finishReason})`, `the model returned no image (finishReason ${candidate.finishReason})`)) ??
          (raw.slice(0, 300) || L('пустой ответ', 'empty response'));
        // Gemini API не работает в части стран (в России тоже) — ответ 400 FAILED_PRECONDITION
        const region = opts.service === 'google' && /location is not supported/i.test(why);
        const hint = region ? L(' Gemini API не работает в вашей стране: выберите laozhang.ai в настройках.', ' Gemini API is not available in your country: choose laozhang.ai in Settings.') : '';
        throw new ProviderError(`${name}, HTTP ${res.status}: ${why}${text ? L(` — «${text}»`, ` — “${text}”`) : ''}${hint}`, {
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

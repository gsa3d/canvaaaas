// Директор: перед генерацией ChatGPT смотрит на кусок, задачу художника и стиль документа и расписывает задачу
// подробно и однозначно — что и где нарисовать, как оно вписывается в окружение. Модель картинок получает
// и этот текст, и слова художника; интерфейс показывает оба, задача художника не меняется.
import type { InputImage } from './types.ts';

export interface DirectorRequest {
  /** Задача художника, как он её написал */
  request: string;
  style?: string;
  /** Модель картинок не увидит, что сейчас под маской: область ей зальют серым */
  hide: boolean;
  /** Картинки по порядку: кусок, он же с подсветкой, с наброском (sketch), весь холст (overview), референсы */
  images: InputImage[];
  sketch: boolean;
  overview: boolean;
  references: number;
  signal?: AbortSignal;
}

export interface DirectorResult {
  text: string;
  elapsedMs: number;
}

export interface PromptDirector {
  readonly id: string;
  readonly model: string;
  direct(req: DirectorRequest): Promise<DirectorResult>;
}

/** Что сказать ChatGPT: что на картинках, задача художника и каким должен быть ответ */
export function directorPrompt(req: Omit<DirectorRequest, 'images' | 'signal'>): string {
  const images = ['- Image 1: a crop of the illustration around the area to repaint.', '- Image 2: the same crop with that area tinted magenta and outlined.'];
  let n = 3;
  if (req.sketch) images.push(`- Image ${n++}: the same crop with the artist's rough sketch over it: where the new content goes, its rough shape, size and pose.`);
  if (req.overview) images.push(`- Image ${n++}: the whole illustration, downscaled, with the crop outlined in magenta.`);
  if (req.references === 1) images.push(`- Image ${n}: a reference image from the artist (a character, object or style to follow).`);
  else if (req.references > 1) images.push(`- Images ${n}–${n + req.references - 1}: reference images from the artist (characters, objects or style to follow).`);
  return [
    'You are the art director in an illustration editing app. The artist selected an area of a large illustration and wrote a short task for it. An image model will repaint only that area, guided by your text. Rewrite the task as a precise, detailed instruction, so the image model draws exactly what the artist means.',
    '',
    'Images:',
    ...images,
    '',
    `Artist's task: ${req.request.trim()}`,
    ...(req.style?.trim() ? [`Style of the whole illustration: ${req.style.trim()}`] : []),
    ...(req.hide
      ? ['The image model will NOT see what is inside the area now: it gets the area painted flat gray and paints it from scratch. Describe everything that must appear there; do not rely on the current content.']
      : []),
    '',
    'Write the instruction:',
    '- Keep the artist\'s intent exactly. Do not add objects, text or changes they did not ask for. If the task is ambiguous, choose the reading that fits the picture best.',
    '- Say what to draw in the area: the subjects, their placement and size relative to what is around, pose, materials and colors.',
    '- Say how it must fit in: perspective, light direction and shadows, line work and rendering style of the surroundings, and how it joins what is at the edges of the area.',
    '- If something in the area has to go or be replaced, say what, and what takes its place.',
    '- Call the area "the area". You may mention the sketch and the reference images, but not image numbers, the magenta tint or this app.',
    '- Plain English, 40–120 words, one paragraph.',
    '',
    'Do not run commands or use any tools: just look at the images and answer. Reply with the instruction only, between <task> and </task>.',
  ].join('\n');
}

/** Текст директора из его ответа: между <task> и </task>, а если тегов нет — ответ целиком */
export function parseDirector(message: string): string {
  const tagged = /<task>([\s\S]*?)<\/task>/i.exec(message)?.[1] ?? message.replace(/<\/?task>/gi, '');
  const text = tagged.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('директор ответил пустым текстом');
  return text;
}

export interface MockDirector extends PromptDirector {
  readonly calls: DirectorRequest[];
}

/** Директор без сети — для тестов и разработки: номер вызова в тексте показывает, звали его заново или нет */
export function mockDirector(opts: { delayMs?: number } = {}): MockDirector {
  const calls: DirectorRequest[] = [];
  return {
    id: 'mock-director',
    model: 'mock',
    calls,
    async direct(req) {
      calls.push(req);
      const started = Date.now();
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (req.signal?.aborted) throw new Error('Директор отменён');
      const text = `In the area, ${req.request.trim()}${req.hide ? ', painted from scratch' : ''}, matching the light and line work around it (mock director #${calls.length}).`;
      return { text, elapsedMs: Date.now() - started };
    },
  };
}

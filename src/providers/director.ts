// Директор: перед генерацией ChatGPT смотрит на кусок, задачу художника и стиль документа и расписывает задачу
// подробно и однозначно — что и где нарисовать, как оно вписывается в окружение. Модель картинок получает
// и этот текст, и слова художника; интерфейс показывает оба, задача художника не меняется.
// Он же критик: после каждого шага смотрит, что получилось, и говорит, что исправить на следующем, или что правка готова.
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

export interface CriticRequest {
  /** Задача художника */
  request: string;
  /** Задача, как её расписал директор для модели */
  directed?: string;
  style?: string;
  /** Модель не видела, что было под маской, и рисовала область с нуля */
  hide: boolean;
  /** Что этот вариант должен был исправить: замечания к прежнему шагу */
  fixes?: string;
  /** Художник сам попросил ещё шаг: нужны замечания, «готово» не ответ */
  mustFix: boolean;
  /** Картинки по порядку: кусок до правки, он же с подсветкой, кусок после правки, с наброском (sketch), весь холст (overview), референсы */
  images: InputImage[];
  sketch: boolean;
  overview: boolean;
  references: number;
  signal?: AbortSignal;
}

export interface CriticResult {
  /** Правка готова: ещё один шаг её заметно не улучшит */
  done: boolean;
  /** Почему готово или что исправить — по строке на замечание */
  text: string;
  elapsedMs: number;
}

export interface PromptDirector {
  readonly id: string;
  readonly model: string;
  direct(req: DirectorRequest): Promise<DirectorResult>;
  /** Критик: что исправить в варианте на следующем шаге */
  review(req: CriticRequest): Promise<CriticResult>;
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

/** Что сказать критику: что на картинках, задача и что проверить; ответ — «готово» или замечания для модели */
export function criticPrompt(req: Omit<CriticRequest, 'images' | 'signal'>): string {
  const images = [
    '- Image 1: a crop of the illustration before the edit.',
    '- Image 2: the same crop with the area to repaint tinted magenta and outlined.',
    '- Image 3: the same crop after the edit. Only the area could change; everything outside it is the original.',
  ];
  let n = 4;
  if (req.sketch) images.push(`- Image ${n++}: the crop before the edit with the artist's rough sketch over it: where the new content goes, its rough shape, size and pose.`);
  if (req.overview) images.push(`- Image ${n++}: the whole illustration before the edit, downscaled, with the crop outlined in magenta.`);
  if (req.references === 1) images.push(`- Image ${n}: a reference image from the artist (a character, object or style to follow).`);
  else if (req.references > 1) images.push(`- Images ${n}–${n + req.references - 1}: reference images from the artist (characters, objects or style to follow).`);
  const fixes = 'between <fix> and </fix>, one per line starting with "- ", most important first. Each is a short, concrete instruction for the image model: what to change, where and how (for example "- Make the boat half as big and move it closer to the shore."). Refer to things by what and where they are, not by image numbers; do not mention the magenta tint or this app. Ask only for changes inside the area and within the artist\'s task.';
  return [
    'You are the art director in an illustration editing app. The artist selected an area of a large illustration and wrote a task for it; an image model repainted that area. Review the result and tell the image model what to fix in its next attempt, which will edit this result.',
    '',
    'Images:',
    ...images,
    '',
    `Artist's task: ${req.request.trim()}`,
    ...(req.directed?.trim() ? [`The task as spelled out for the image model: ${req.directed.trim()}`] : []),
    ...(req.style?.trim() ? [`Style of the whole illustration: ${req.style.trim()}`] : []),
    ...(req.hide ? ['The image model did not see what was inside the area before: it painted the area from scratch, so the old content does not have to survive.'] : []),
    ...(req.fixes?.trim() ? ['', 'This attempt was asked to fix:', req.fixes.trim()] : []),
    '',
    'Check:',
    `- Is the task done completely, in the right place, at the right size and pose${req.sketch ? ', following the sketch' : ''}?`,
    '- Does it blend in: perspective, light and shadows, line work, colors and rendering style of the surroundings, no visible seam at the edge of the area?',
    '- Defects: broken anatomy, extra or missing parts, smudges, leftover gray or magenta, text or borders.',
    ...(req.fixes?.trim() ? ['- Were the requested fixes made, without breaking what already worked?'] : []),
    '',
    ...(req.mustFix
      ? [`The artist asked for another attempt: find what would make it clearly better. Reply with up to 5 fixes ${fixes}`]
      : [
          'If the task is done well and blends in, so that another attempt would not clearly improve it, reply with one short sentence saying so, between <done> and </done>.',
          `Otherwise reply with up to 5 fixes ${fixes}`,
        ]),
    '',
    'Do not run commands or use any tools: just look at the images and answer.',
  ].join('\n');
}

/** Ответ критика: «готово» между <done> и </done> или замечания между <fix> и </fix>; без тегов — весь ответ замечаниями */
export function parseCritic(message: string): { done: boolean; text: string } {
  const fix = /<fix>([\s\S]*?)<\/fix>/i.exec(message)?.[1];
  const done = /<done>([\s\S]*?)<\/done>/i.exec(message)?.[1];
  if (fix === undefined && done !== undefined) return { done: true, text: done.replace(/\s+/g, ' ').trim() };
  const text = (fix ?? message.replace(/<\/?(fix|done)>/gi, ''))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  if (!text) throw new Error('критик ответил пустым текстом');
  return { done: false, text };
}

export interface MockDirector extends PromptDirector {
  readonly calls: DirectorRequest[];
  readonly reviews: CriticRequest[];
}

/**
 * Директор без сети — для тестов и разработки: номер вызова в тексте показывает, звали его заново или нет.
 * Критик даёт замечания, а с doneAt — с этого по счёту вызова говорит «готово» (если художник не просил ещё шаг).
 */
export function mockDirector(opts: { delayMs?: number; doneAt?: number } = {}): MockDirector {
  const calls: DirectorRequest[] = [];
  const reviews: CriticRequest[] = [];
  const wait = async (signal?: AbortSignal) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (signal?.aborted) throw new Error('Директор отменён');
  };
  return {
    id: 'mock-director',
    model: 'mock',
    calls,
    reviews,
    async direct(req) {
      calls.push(req);
      const started = Date.now();
      await wait(req.signal);
      const text = `In the area, ${req.request.trim()}${req.hide ? ', painted from scratch' : ''}, matching the light and line work around it (mock director #${calls.length}).`;
      return { text, elapsedMs: Date.now() - started };
    },
    async review(req) {
      reviews.push(req);
      const started = Date.now();
      await wait(req.signal);
      const k = reviews.length;
      const done = !req.mustFix && opts.doneAt !== undefined && k >= opts.doneAt;
      const text = done ? `The edit fits well (mock critic #${k}).` : `- Make the change bolder (mock critic #${k}).\n- Soften the edge of the area.`;
      return { done, text, elapsedMs: Date.now() - started };
    },
  };
}

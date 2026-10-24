// ChatGPT Images по подписке ChatGPT, без API: картинку рисует встроенный инструмент Codex CLI,
// вошедшего в ChatGPT. canvaaaas запускает `codex exec` и просит агента вызвать инструмент ровно один раз
// с нашим промптом и кусками; готовый файл Codex кладёт в $CODEX_HOME/generated_images/<id сессии>/.
// В JSON-событиях `codex exec` генерации картинки нет, поэтому ошибку инструмента (например, лимит подписки)
// ищем в журнале сессии $CODEX_HOME/sessions/ГГГГ/ММ/ДД/rollout-…-<id сессии>.jsonl.
// Размер ответа инструменту не задаётся: модель отдаёт около 1,57 Мп в пропорциях первой картинки.
// Тот же Codex без инструмента картинок — директор и критик: агент смотрит на кусок и отвечает текстом.
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, extname, join } from 'node:path';
import { criticPrompt, directorPrompt, parseCritic, parseDirector, type PromptDirector } from './director.ts';
import { ProviderError, type GenerateRequest, type GenerateResult, type ImageProvider, type InputImage, type Size } from './types.ts';

/** Площадь ответа: 1254×1254, 1448×1086, 1484×1060 — модель держит её и подстраивает стороны под пропорции */
const OUTPUT_AREA = 1254 * 1254;
/** Единственное «разрешение»: выбрать другое у инструмента нельзя */
export const CHATGPT_SIZE = '1,6 Мп';
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'];
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export interface ChatgptCodexOptions {
  /** Путь к codex; по умолчанию его ищет findCodex() перед каждой генерацией */
  codexPath?: string;
  /** Папка Codex (вход в ChatGPT, готовые картинки, журналы сессий); по умолчанию CODEX_HOME или ~/.codex */
  codexHome?: string;
  /** Модель агента, который вызывает инструмент; по умолчанию CANVAAAAS_CODEX_MODEL или модель Codex по умолчанию */
  agentModel?: string;
  timeoutMs?: number;
  /** Сколько codex работает одновременно: остальные генерации ждут */
  parallel?: number;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Codex CLI: CANVAAAAS_CODEX, затем PATH, затем известные места; null — не установлен */
export function findCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const home = homedir();
  const candidates = [
    env.CANVAAAAS_CODEX,
    ...(env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, exe)),
    // Приложение, открытое из Finder, получает урезанный PATH: Homebrew, npm и ~/.local в него не попадают
    ...(process.platform === 'darwin'
      ? [
          '/opt/homebrew/bin/codex',
          '/usr/local/bin/codex',
          join(home, '.local/bin/codex'),
          join(home, '.npm-global/bin/codex'),
          // Codex, встроенный в приложение ChatGPT: обновляется вместе с ним
          '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
          join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
        ]
      : []),
  ];
  return candidates.find((p): p is string => !!p && isFile(p)) ?? null;
}

export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), '.codex');
}

function requireCodex(path: string | undefined): string {
  const bin = path ?? findCodex();
  if (!bin) {
    throw new ProviderError('Не найден Codex CLI, через который идёт ChatGPT по подписке. Установите приложение ChatGPT (в нём есть Codex) или Codex CLI.');
  }
  return bin;
}

/** Окружение codex: с ключом API в нём Codex платил бы по API, а не по подписке */
function codexEnv(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

/** Картинки во временную папку по порядку: 1.jpg, 2.jpg… */
async function writeImages(dir: string, images: InputImage[]): Promise<string[]> {
  const paths: string[] = [];
  for (const [i, img] of images.entries()) {
    const path = join(dir, `${i + 1}${img.mimeType === 'image/png' ? '.png' : img.mimeType === 'image/webp' ? '.webp' : '.jpg'}`);
    await writeFile(path, img.data);
    paths.push(path);
  }
  return paths;
}

function ratioOf(aspectRatio: string): number {
  const [w, h] = aspectRatio.split(':').map(Number);
  if (!w || !h) throw new Error(`Непонятные пропорции: ${aspectRatio}`);
  return w / h;
}

/** Не больше max задач одновременно; отменённая в ожидании задача уходит из очереди */
function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    while (active >= max) {
      if (signal?.aborted) throw new ProviderError('Генерация отменена');
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', stop);
          resolve();
        };
        const stop = () => {
          queue.splice(queue.indexOf(go), 1);
          reject(new ProviderError('Генерация отменена'));
        };
        queue.push(go);
        signal?.addEventListener('abort', stop, { once: true });
      });
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** Что агент Codex должен сделать: один вызов инструмента картинок с нашим промптом как есть */
export function agentPrompt(prompt: string, paths: string[]): string {
  return [
    'You are a relay inside an image editing app. Your only job is to call the image generation tool exactly once, then stop.',
    '',
    'Call it with:',
    '- prompt: the text between <prompt> and </prompt> below, verbatim. Do not reword, shorten, translate or add to it.',
    `- referenced_image_paths: ${JSON.stringify(paths)}, in exactly this order (image 1 first).`,
    '- transparent_background: false.',
    '',
    'Do not inspect the images, run shell commands, or create, copy or move files. Generate one image only.',
    'If the tool fails, reply with its error message. Otherwise reply with one word: done.',
    '',
    '<prompt>',
    prompt,
    '</prompt>',
  ].join('\n');
}

interface CodexRun {
  threadId?: string;
  /** Ответы агента */
  messages: string[];
  /** Ошибки из событий error и turn.failed */
  errors: string[];
  stderr: string;
  code: number | null;
  aborted: boolean;
  timedOut: boolean;
}

function runCodex(bin: string, args: string[], input: string, opts: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }): Promise<CodexRun> {
  return new Promise((resolve, reject) => {
    const run: CodexRun = { messages: [], errors: [], stderr: '', code: null, aborted: false, timedOut: false };
    // Отменили, пока готовили кусок: событие abort уже было, и codex никто бы не остановил
    if (opts.signal?.aborted) {
      resolve({ ...run, aborted: true });
      return;
    }
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const timer = setTimeout(() => {
      run.timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => {
      run.aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    let pending = '';
    const onLine = (line: string) => {
      let ev: { type?: string; thread_id?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string } };
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'thread.started' && ev.thread_id) run.threadId = ev.thread_id;
      else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) run.messages.push(ev.item.text);
      else if (ev.type === 'error' && ev.message) run.errors.push(ev.message);
      else if (ev.type === 'turn.failed' && ev.error?.message) run.errors.push(ev.error.message);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) onLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      run.stderr = (run.stderr + chunk).slice(-4000);
    });
    // codex мог закрыть stdin раньше, чем дочитал: это не ошибка генерации
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);

    const done = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code) => {
      done();
      if (pending.trim()) onLine(pending);
      run.code = code;
      resolve(run);
    });
  });
}

interface RolloutInfo {
  savedPaths: string[];
  /** Картинки base64, если файла почему-то нет */
  results: string[];
  failures: unknown[];
  revisedPrompt?: string;
}

/** Генерации картинок в журнале сессии Codex: путь к файлу, сама картинка, ошибка инструмента */
export function scanRollout(text: string): RolloutInfo {
  const info: RolloutInfo = { savedPaths: [], results: [], failures: [] };
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (o.kind === 'image_gen.generation' || (typeof o.type === 'string' && o.type.startsWith('image_generation'))) {
      const path = o.savedPath ?? o.saved_path;
      if (typeof path === 'string') info.savedPaths.push(path);
      if (typeof o.result === 'string' && o.result.length > 100) info.results.push(o.result);
      if (o.failure) info.failures.push(o.failure);
      const revised = o.revisedPrompt ?? o.revised_prompt;
      if (typeof revised === 'string') info.revisedPrompt = revised;
      return;
    }
    for (const x of Object.values(o)) visit(x);
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      visit(JSON.parse(line));
    } catch {
      // Недописанная строка: журнал мог ещё дописываться
    }
  }
  return info;
}

/** Журнал сессии лежит в папке дня её начала — по местному времени, на всякий случай смотрим и UTC */
async function findRollout(codexHome: string, threadId: string, started: Date): Promise<string | null> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = new Set<string>();
  for (const t of [started, new Date()]) {
    days.add(join(String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate())));
    days.add(join(String(t.getUTCFullYear()), pad(t.getUTCMonth() + 1), pad(t.getUTCDate())));
  }
  for (const day of days) {
    const dir = join(codexHome, 'sessions', day);
    const names = await readdir(dir).catch(() => [] as string[]);
    const name = names.find((n) => n.includes(threadId) && n.endsWith('.jsonl'));
    if (name) return join(dir, name);
  }
  return null;
}

/** Самая свежая картинка в папке; null — папки нет или она пустая */
async function newestImage(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!IMAGE_EXTENSIONS.has(extname(name).toLowerCase())) continue;
    const path = join(dir, name);
    const { mtimeMs } = await stat(path);
    if (!best || mtimeMs > best.mtime) best = { path, mtime: mtimeMs };
  }
  return best?.path ?? null;
}

function mimeOf(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
}

function formatReset(value: unknown): string | null {
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export function describeFailure(failure: unknown): string {
  if (typeof failure === 'string') return failure;
  const o = (failure ?? {}) as Record<string, unknown>;
  const kind = o.type ?? o.kind;
  if (kind === 'usageLimitExceeded' || 'resetsAt' in o) {
    const at = formatReset(o.resetsAt);
    return `исчерпан лимит картинок по подписке ChatGPT${at ? `, он обновится ${at}` : ''}`;
  }
  const text = o.message ?? o.error ?? o.reason;
  return typeof text === 'string' ? text : JSON.stringify(failure).slice(0, 300);
}

function clean(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '').trim();
}

function lastLines(text: string, max = 300): string {
  const lines = clean(text).split('\n').filter((l) => l.trim());
  return lines.slice(-3).join(' ').slice(-max);
}

const LOGIN_HINT = /not logged in|codex login|401|unauthori[sz]ed|refresh token|sign in/i;

export function chatgptCodex(opts: ChatgptCodexOptions = {}): ImageProvider {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const limit = limiter(opts.parallel ?? 2);
  const model = 'chatgpt-images';
  const outputSize = (aspectRatio: string, imageSize: string): Size => {
    if (imageSize !== CHATGPT_SIZE || !ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`ChatGPT Images не поддерживает ${aspectRatio} ${imageSize}`);
    const r = ratioOf(aspectRatio);
    return { width: Math.round(Math.sqrt(OUTPUT_AREA * r)), height: Math.round(Math.sqrt(OUTPUT_AREA / r)) };
  };

  return {
    id: 'chatgpt-codex',
    model,
    aspectRatios: ASPECT_RATIOS,
    imageSizes: [CHATGPT_SIZE],
    outputSize,

    generate(req: GenerateRequest): Promise<GenerateResult> {
      return limit(async () => {
        const bin = requireCodex(opts.codexPath);
        const codexHome = opts.codexHome ?? codexHomeDir();
        const agentModel = opts.agentModel ?? process.env.CANVAAAAS_CODEX_MODEL;
        const dir = await mkdtemp(join(tmpdir(), 'canvaaaas-chatgpt-'));
        try {
          const paths = await writeImages(dir, req.images);
          const out = outputSize(req.aspectRatio, req.imageSize);
          const prompt = `${req.prompt}\n\nReturn a single image with the same ${req.aspectRatio} aspect ratio and framing as image 1 (${out.width}×${out.height} px).`;
          const args = [
            'exec',
            '--json',
            '--skip-git-repo-check',
            // Без config.toml пользователя: его MCP-серверы и тяжёлые настройки модели здесь только замедляют. Вход в ChatGPT остаётся
            '--ignore-user-config',
            '--sandbox',
            'read-only',
            '--cd',
            dir,
            '-c',
            'features.image_generation=true',
            '-c',
            'model_reasoning_effort="low"',
            ...(agentModel ? ['--model', agentModel] : []),
            // Агент сразу видит картинки и не тратит шаги на их просмотр; промпт идёт через stdin
            ...paths.flatMap((p) => ['--image', p]),
          ];
          const started = new Date();
          let run: CodexRun;
          try {
            run = await runCodex(bin, args, agentPrompt(prompt, paths), { cwd: dir, env: codexEnv(codexHome), signal: req.signal, timeoutMs });
          } catch (err) {
            throw new ProviderError(`Не удалось запустить Codex (${bin}): ${err instanceof Error ? err.message : String(err)}`);
          }
          if (run.aborted) throw new ProviderError('Генерация отменена');
          const elapsedMs = Date.now() - started.getTime();

          const rolloutPath = run.threadId ? await findRollout(codexHome, run.threadId, started) : null;
          const rollout = rolloutPath ? scanRollout(await readFile(rolloutPath, 'utf8')) : { savedPaths: [], results: [], failures: [] };
          const file =
            (run.threadId ? await newestImage(join(codexHome, 'generated_images', run.threadId)) : null) ??
            rollout.savedPaths.findLast((p) => isFile(p)) ??
            null;
          const base64 = rollout.results.at(-1);
          if (file || base64) {
            return {
              image: file ? await readFile(file) : Buffer.from(base64!, 'base64'),
              mimeType: file ? mimeOf(file) : 'image/png',
              model,
              elapsedMs,
              text: rollout.revisedPrompt,
            };
          }

          if (run.timedOut) throw new ProviderError(`ChatGPT не ответил за ${Math.round(timeoutMs / 60_000)} мин`, { retryable: true });
          const reasons = [...rollout.failures.map(describeFailure), ...run.errors.map(clean), ...run.messages.map(clean).filter((m) => !/^done\.?$/i.test(m))];
          const said = reasons.join(' — ') || lastLines(run.stderr) || `codex завершился с кодом ${run.code}`;
          // Инструмент картинок отработал и сам сказал, что не так, — значит, вход в порядке
          if (!rollout.failures.length && (LOGIN_HINT.test(said) || LOGIN_HINT.test(run.stderr))) {
            throw new ProviderError(`Codex не вошёл в ChatGPT: войдите в Codex в приложении ChatGPT или в Терминале командой «${bin} login». (${said})`);
          }
          throw new ProviderError(`ChatGPT не вернул картинку: ${said}`, { retryable: rollout.failures.length === 0 });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }, req.signal);
    },
  };
}

/**
 * Директор и критик на ChatGPT по подписке: тот же Codex, но без инструмента картинок — агент смотрит на картинки и отвечает текстом.
 * Рассуждает чуть дольше, чем при генерации картинки: здесь ответ и есть его работа.
 */
export function chatgptDirector(opts: ChatgptCodexOptions = {}): PromptDirector {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const limit = limiter(opts.parallel ?? 2);
  /** Последний ответ агента на prompt с картинками */
  const ask = (prompt: string, images: InputImage[], signal?: AbortSignal) =>
    limit(async () => {
      const bin = requireCodex(opts.codexPath);
      const codexHome = opts.codexHome ?? codexHomeDir();
      const agentModel = opts.agentModel ?? process.env.CANVAAAAS_CODEX_MODEL;
      const dir = await mkdtemp(join(tmpdir(), 'canvaaaas-director-'));
      try {
        const paths = await writeImages(dir, images);
        const args = [
          'exec',
          '--json',
          '--skip-git-repo-check',
          '--ignore-user-config',
          '--sandbox',
          'read-only',
          '--cd',
          dir,
          '-c',
          'model_reasoning_effort="medium"',
          ...(agentModel ? ['--model', agentModel] : []),
          ...paths.flatMap((p) => ['--image', p]),
        ];
        const started = Date.now();
        let run: CodexRun;
        try {
          run = await runCodex(bin, args, prompt, { cwd: dir, env: codexEnv(codexHome), signal, timeoutMs });
        } catch (err) {
          throw new ProviderError(`Не удалось запустить Codex (${bin}): ${err instanceof Error ? err.message : String(err)}`);
        }
        if (run.aborted) throw new ProviderError('Генерация отменена');
        if (run.timedOut) throw new ProviderError(`ChatGPT не ответил за ${Math.round(timeoutMs / 60_000)} мин`, { retryable: true });
        // Ошибки бывают и у удачного ответа (переподключение): ответ агента главнее
        const message = run.messages.at(-1);
        if (message) return { message, elapsedMs: Date.now() - started };
        const said = run.errors.map(clean).join(' — ') || lastLines(run.stderr) || `codex завершился с кодом ${run.code}`;
        if (LOGIN_HINT.test(said) || LOGIN_HINT.test(run.stderr)) {
          throw new ProviderError(`Codex не вошёл в ChatGPT: войдите в Codex в приложении ChatGPT или в Терминале командой «${bin} login». (${said})`);
        }
        throw new ProviderError(`ChatGPT не ответил: ${said}`, { retryable: true });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, signal);
  return {
    id: 'chatgpt-director',
    model: 'chatgpt',
    async direct(req) {
      const { message, elapsedMs } = await ask(directorPrompt(req), req.images, req.signal);
      return { text: parseDirector(message), elapsedMs };
    },
    async review(req) {
      const { message, elapsedMs } = await ask(criticPrompt(req), req.images, req.signal);
      return { ...parseCritic(message), elapsedMs };
    },
  };
}

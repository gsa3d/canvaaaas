// ChatGPT по подписке через Codex CLI — с подставным codex: он пишет события, как `codex exec --json`,
// кладёт картинку и журнал сессии туда же, куда настоящий, и запоминает, с чем его запустили.
// Настоящий Codex и вход в ChatGPT тут не нужны, генерации не тратятся.
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compositeVariant, prepareEdit } from '../src/core/edit-region.ts';
import { renderMask } from '../src/core/mask-shapes.ts';
import { agentPrompt, CHATGPT_SIZE, chatgptCodex, chatgptDirector, describeFailure, scanRollout } from '../src/providers/chatgpt-codex.ts';

const FAKE_CODEX = `
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.CODEX_HOME;
const mode = process.env.FAKE_MODE;
const args = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
const images = args.flatMap((a, i) => (args[i - 1] === '--image' ? [a] : []));
writeFileSync(process.env.FAKE_LOG, JSON.stringify({
  args, input, cwd: process.cwd(), apiKey: process.env.OPENAI_API_KEY ?? null,
  imageBytes: images.map((p) => readFileSync(p).length),
}));
const thread = 'thread-' + process.pid;
const say = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
say({ type: 'thread.started', thread_id: thread });
say({ type: 'turn.started' });
if (mode === 'hang') {
  setInterval(() => undefined, 1000);
} else if (mode === 'nologin') {
  process.stderr.write('Error: Not logged in\\n');
  process.exit(1);
} else if (mode === 'director') {
  say({ type: 'error', message: 'Reconnecting... 1/5' });
  say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'Here it is:\\n<task>Paint a small red boat\\non the water.</task>' } });
  say({ type: 'turn.completed', usage: {} });
} else if (mode === 'critic') {
  say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '<fix>\\n- Make the boat smaller.\\n- Shadow to the left.\\n</fix>' } });
  say({ type: 'turn.completed', usage: {} });
} else {
  setTimeout(() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const day = join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    mkdirSync(day, { recursive: true });
    const item = { type: 'Extension', kind: 'image_gen.generation', id: 'exec-1', status: 'completed', revisedPrompt: 'revised', failure: null };
    if (mode === 'ok') {
      const dir = join(home, 'generated_images', thread);
      mkdirSync(dir, { recursive: true });
      item.savedPath = join(dir, 'exec-1.png');
      copyFileSync(process.env.FAKE_OUTPUT, item.savedPath);
    } else if (mode === 'rollout') {
      item.result = readFileSync(process.env.FAKE_OUTPUT).toString('base64');
    } else if (mode === 'limit') {
      item.status = 'failed';
      item.failure = { type: 'usageLimitExceeded', limitId: 'images', resetsAt: 1790000000 };
    }
    appendFileSync(join(day, 'rollout-x-' + thread + '.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } }) + '\\n');
    say({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: mode === 'limit' ? 'The image tool failed.' : 'done' } });
    say({ type: 'turn.completed', usage: {} });
  }, Number(process.env.FAKE_DELAY ?? 0));
}
`;

let dir: string;
let codexPath: string;
let codexHome: string;
let output: Buffer;
const log = () => join(dir, 'log.json');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'canvaaaas-codex-test-'));
  codexHome = join(dir, 'codex-home');
  const script = join(dir, 'fake-codex.mjs');
  await writeFile(script, FAKE_CODEX);
  codexPath = join(dir, 'codex');
  await writeFile(codexPath, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(codexPath, 0o755);
  output = await sharp({ create: { width: 1448, height: 1086, channels: 3, background: '#3366aa' } }).png().toBuffer();
  await writeFile(join(dir, 'output.png'), output);
  Object.assign(process.env, { FAKE_LOG: log(), FAKE_OUTPUT: join(dir, 'output.png'), FAKE_DELAY: '0' });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const jpeg = async (color: string) => ({
  data: await sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).jpeg().toBuffer(),
  mimeType: 'image/jpeg',
});

describe.skipIf(process.platform === 'win32')('ChatGPT через Codex CLI', () => {
  it('размер ответа — около 1,57 Мп в пропорциях куска', () => {
    const p = chatgptCodex({ codexPath: 'codex', codexHome: 'x' });
    expect(p.imageSizes).toEqual([CHATGPT_SIZE]);
    expect(p.outputSize('1:1', CHATGPT_SIZE)).toEqual({ width: 1254, height: 1254 });
    expect(p.outputSize('4:3', CHATGPT_SIZE)).toEqual({ width: 1448, height: 1086 });
    expect(p.outputSize('3:4', CHATGPT_SIZE)).toEqual({ width: 1086, height: 1448 });
    expect(() => p.outputSize('4:3', '2K')).toThrow();
  });

  it('картинка из generated_images сессии; промпт как есть, ключ API не уходит, временная папка удаляется', async () => {
    process.env.FAKE_MODE = 'ok';
    process.env.OPENAI_API_KEY = 'sk-test-not-for-codex';
    try {
      const p = chatgptCodex({ codexPath, codexHome });
      const res = await p.generate({ prompt: 'TASK: add a red boat', images: [await jpeg('#fff'), await jpeg('#f0f')], aspectRatio: '4:3', imageSize: CHATGPT_SIZE });
      expect(res.image.equals(output)).toBe(true);
      expect(res.mimeType).toBe('image/png');
      expect(res.text).toBe('revised');

      const run = JSON.parse(await readFile(log(), 'utf8'));
      expect(run.args.slice(0, 2)).toEqual(['exec', '--json']);
      expect(run.args).toContain('--skip-git-repo-check');
      expect(run.apiKey).toBeNull();
      expect(run.imageBytes).toHaveLength(2);
      expect(run.input).toContain('TASK: add a red boat');
      expect(run.input).toContain('1448×1086');
      const paths = run.args.flatMap((a: string, i: number) => (run.args[i - 1] === '--image' ? [a] : []));
      expect(run.input).toContain(JSON.stringify(paths));
      expect(existsSync(run.args[run.args.indexOf('--cd') + 1])).toBe(false);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('картинка только в журнале сессии (base64) — тоже годится', async () => {
    process.env.FAKE_MODE = 'rollout';
    const res = await chatgptCodex({ codexPath, codexHome }).generate({ prompt: 'x', images: [await jpeg('#fff')], aspectRatio: '1:1', imageSize: CHATGPT_SIZE });
    expect(res.image.equals(output)).toBe(true);
  });

  it('лимит подписки и вход в ChatGPT — понятными словами', async () => {
    const p = chatgptCodex({ codexPath, codexHome });
    const req = { prompt: 'x', images: [await jpeg('#fff')], aspectRatio: '1:1', imageSize: CHATGPT_SIZE };
    process.env.FAKE_MODE = 'limit';
    await expect(p.generate(req)).rejects.toThrow(/лимит картинок по подписке ChatGPT, он обновится/);
    process.env.FAKE_MODE = 'nologin';
    await expect(p.generate(req)).rejects.toThrow(/не вошёл в ChatGPT.*login/);
  });

  it('отмена и таймаут останавливают codex', async () => {
    process.env.FAKE_MODE = 'hang';
    const req = { prompt: 'x', images: [await jpeg('#fff')], aspectRatio: '1:1', imageSize: CHATGPT_SIZE };
    const abort = new AbortController();
    const pending = chatgptCodex({ codexPath, codexHome }).generate({ ...req, signal: abort.signal });
    setTimeout(() => abort.abort(), 300);
    await expect(pending).rejects.toThrow('Генерация отменена');
    await expect(chatgptCodex({ codexPath, codexHome, timeoutMs: 300 }).generate(req)).rejects.toThrow(/не ответил/);
    // Отменили ещё до запуска codex: он не должен остаться висеть
    const early = new AbortController();
    early.abort();
    await expect(chatgptCodex({ codexPath, codexHome }).generate({ ...req, signal: early.signal })).rejects.toThrow('Генерация отменена');
  });

  it('не больше parallel запусков сразу; отменённая в очереди генерация не держит место', async () => {
    process.env.FAKE_MODE = 'ok';
    process.env.FAKE_DELAY = '400';
    try {
      const p = chatgptCodex({ codexPath, codexHome, parallel: 1 });
      const req = { prompt: 'x', images: [await jpeg('#fff')], aspectRatio: '1:1', imageSize: CHATGPT_SIZE };
      const started = Date.now();
      const first = p.generate(req);
      const abort = new AbortController();
      const queued = p.generate({ ...req, signal: abort.signal });
      abort.abort();
      await expect(queued).rejects.toThrow('Генерация отменена');
      expect(Date.now() - started).toBeLessThan(300);
      const third = p.generate(req);
      await first;
      await third;
      expect(Date.now() - started).toBeGreaterThanOrEqual(800);
    } finally {
      process.env.FAKE_DELAY = '0';
    }
  });

  it('директор и критик: тот же Codex без инструмента картинок, картинки по порядку, ответ — текст между тегами', async () => {
    process.env.FAKE_MODE = 'director';
    process.env.OPENAI_API_KEY = 'sk-test-not-for-codex';
    try {
      const director = chatgptDirector({ codexPath, codexHome });
      const req = { request: 'лодка', style: 'акварель', hide: false, sketch: false, overview: false, references: 0, images: [await jpeg('#fff'), await jpeg('#f0f')] };
      const res = await director.direct(req);
      expect(res.text).toBe('Paint a small red boat on the water.');
      const run = JSON.parse(await readFile(log(), 'utf8'));
      expect(run.args.slice(0, 2)).toEqual(['exec', '--json']);
      expect(run.args).toContain('--ignore-user-config');
      expect(run.args.join(' ')).not.toContain('image_generation');
      expect(run.imageBytes).toHaveLength(2);
      expect(run.apiKey).toBeNull();
      expect(run.input).toContain("Artist's task: лодка");
      expect(existsSync(run.args[run.args.indexOf('--cd') + 1])).toBe(false);

      process.env.FAKE_MODE = 'critic';
      const review = await director.review({ request: 'лодка', hide: false, mustFix: false, sketch: false, overview: false, references: 0, images: [await jpeg('#fff'), await jpeg('#f0f'), await jpeg('#00f')] });
      expect(review).toMatchObject({ done: false, text: '- Make the boat smaller.\n- Shadow to the left.' });
      const critic = JSON.parse(await readFile(log(), 'utf8'));
      expect(critic.imageBytes).toHaveLength(3);
      expect(critic.input).toContain('- Image 3: the same crop after the edit.');
      expect(critic.args.join(' ')).not.toContain('image_generation');

      process.env.FAKE_MODE = 'nologin';
      await expect(director.direct(req)).rejects.toThrow(/не вошёл в ChatGPT/);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('правка области целиком: кусок в пропорциях модели, ответ вклеивается', async () => {
    process.env.FAKE_MODE = 'ok';
    const width = 2400;
    const height = 1800;
    const base = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const mask = await renderMask(width, height, [{ kind: 'rect', x: 1000, y: 700, width: 300, height: 220 }]);
    const provider = chatgptCodex({ codexPath, codexHome });
    const prep = await prepareEdit({ image: base, mask, prompt: 'add a boat', provider });
    expect(prep.imageSize).toBe(CHATGPT_SIZE);
    expect(prep.modelSize).toEqual(provider.outputSize(prep.frame.aspectRatio, CHATGPT_SIZE));
    const res = await provider.generate({ prompt: prep.prompt, images: prep.images, aspectRatio: prep.frame.aspectRatio, imageSize: prep.imageSize });
    const { stats } = await compositeVariant(prep, res.image);
    expect(stats.modelOutput).toEqual({ width: 1448, height: 1086 });
    expect(stats.insideChangedPct).toBeGreaterThan(90);
  });
});

describe('разбор ответа Codex', () => {
  it('журнал сессии: путь, картинка, ошибка инструмента', () => {
    const lines = [
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', text: 'hi' } } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Extension', kind: 'image_gen.generation', savedPath: '/a.png', result: 'A'.repeat(200), failure: null } } },
      { type: 'response_item', payload: { type: 'image_generation_call', result: 'B'.repeat(200), revised_prompt: 'r' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { kind: 'image_gen.generation', failure: { type: 'usageLimitExceeded', resetsAt: 1790000000 } } } },
    ];
    const info = scanRollout(lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"обрыв');
    expect(info.savedPaths).toEqual(['/a.png']);
    expect(info.results).toHaveLength(2);
    expect(info.revisedPrompt).toBe('r');
    expect(info.failures).toHaveLength(1);
    expect(describeFailure(info.failures[0])).toMatch(/^исчерпан лимит картинок по подписке ChatGPT, он обновится \d+/);
    expect(describeFailure({ type: 'other', message: 'content policy' })).toBe('content policy');
  });

  it('промпт агенту: пути в нашем порядке, текст правки между тегами без изменений', () => {
    const text = agentPrompt('TASK: x\n\nline 2', ['/t/1.jpg', '/t/2.jpg']);
    expect(text).toContain('["/t/1.jpg","/t/2.jpg"]');
    expect(text).toContain('<prompt>\nTASK: x\n\nline 2\n</prompt>');
  });
});

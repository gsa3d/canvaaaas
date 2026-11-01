// Nano Banana через Gemini API и через laozhang.ai: запрос уходит на подставной сервер, сеть не нужна.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiImage } from '../src/providers/gemini.ts';
import { Session } from '../src/server/session.ts';
import type { KeyStore, Keys } from '../src/core/secrets.ts';

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: { contents: { parts: Record<string, unknown>[] }[]; generationConfig: unknown };
}

let server: Server;
let baseUrl: string;
let seen: Seen[];
let reply: { status: number; body: unknown };

const IMAGE = Buffer.from('png-bytes');
const THOUGHT = Buffer.from('thought-bytes');

beforeEach(async () => {
  seen = [];
  reply = {
    status: 200,
    body: {
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: 'image/png', data: THOUGHT.toString('base64') }, thought: true },
              { text: 'готово' },
              { inlineData: { mimeType: 'image/png', data: IMAGE.toString('base64') } },
            ],
          },
        },
      ],
    },
  };
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw) as Seen['body'] });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/models`;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

const request = { prompt: 'лодка', images: [{ mimeType: 'image/png', data: Buffer.from('crop') }], aspectRatio: '4:3', imageSize: '2K' };

describe('Nano Banana', () => {
  it('Gemini API: ключ в x-goog-api-key, ответ — картинка, а не та, что модель рисовала, пока думала', async () => {
    const p = geminiImage({ service: 'google', model: 'pro', apiKey: async () => 'AIza-test-key', baseUrl });
    const res = await p.generate(request);
    expect(res.image.equals(IMAGE)).toBe(true);
    expect(res.text).toBe('готово');
    expect(p.id).toBe('google-gemini');
    const [req] = seen;
    expect(req!.url).toBe('/v1beta/models/gemini-3-pro-image-preview:generateContent');
    expect(req!.headers['x-goog-api-key']).toBe('AIza-test-key');
    expect(req!.headers.authorization).toBeUndefined();
    expect(req!.body.generationConfig).toEqual({ responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:3', imageSize: '2K' } });
    expect(req!.body.contents[0]!.parts).toEqual([{ text: 'лодка' }, { inline_data: { mime_type: 'image/png', data: Buffer.from('crop').toString('base64') } }]);
  });

  it('laozhang.ai: тот же запрос, ключ в Authorization: Bearer', async () => {
    const p = geminiImage({ service: 'laozhang', apiKey: async () => 'sk-test-key', baseUrl });
    await p.generate(request);
    const [req] = seen;
    expect(req!.url).toBe('/v1beta/models/gemini-3.1-flash-image-preview:generateContent');
    expect(req!.headers.authorization).toBe('Bearer sk-test-key');
    expect(req!.headers['x-goog-api-key']).toBeUndefined();
    expect(p.id).toBe('laozhang-gemini');
  });

  it('Gemini API не в этой стране — ошибка подсказывает laozhang.ai, ключа в ней нет', async () => {
    reply = { status: 400, body: { error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } } };
    const p = geminiImage({ service: 'google', apiKey: async () => 'AIza-test-key', baseUrl });
    const err = await p.generate(request).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Gemini API, HTTP 400: User location is not supported.*laozhang\.ai в настройках/);
    expect((err as Error).message).not.toContain('AIza-test-key');
  });
});

/** Ключ в памяти вместо Связки ключей */
function memoryStore(value: string | null = null): KeyStore {
  let key = value;
  return { get: async () => key, set: async (k) => void (key = k), clear: async () => void (key = null) };
}

describe('через что идёт Nano Banana', () => {
  const session = async (keys: Keys) => {
    const s = new Session('live', keys);
    await s.init();
    return s;
  };

  it('без выбора — Gemini API, но если ключ есть только у laozhang.ai — он', async () => {
    expect((await session({ google: memoryStore(), laozhang: memoryStore() })).state().gemini).toEqual({ service: 'google', keys: { google: false, laozhang: false } });
    const old = await session({ google: memoryStore(), laozhang: memoryStore('sk-old-key-123') });
    expect(old.state().gemini.service).toBe('laozhang');
    expect(old.state().hasKey).toBe(true);
    const both = await session({ google: memoryStore('AIza-test-key'), laozhang: memoryStore('sk-old-key-123') });
    expect(both.state().gemini.service).toBe('google');
  });

  it('выбор в настройках главнее, ключ сохраняется у своего сервиса, hasKey — у выбранного', async () => {
    const keys = { google: memoryStore(), laozhang: memoryStore('sk-old-key-123') };
    const s = await session(keys);
    await s.setGeminiService('google');
    expect(s.state()).toMatchObject({ hasKey: false, gemini: { service: 'google', keys: { google: false, laozhang: true } } });
    await s.setKey('google', 'AIza-test-key');
    expect(await keys.google.get()).toBe('AIza-test-key');
    expect(await keys.laozhang.get()).toBe('sk-old-key-123');
    expect(s.state().hasKey).toBe(true);
    await s.clearKey('laozhang');
    expect(s.state()).toMatchObject({ hasKey: true, gemini: { service: 'google', keys: { google: true, laozhang: false } } });
    await expect(s.setGeminiService('openai' as never)).rejects.toThrow();
  });
});

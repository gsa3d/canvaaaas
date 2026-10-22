// Журнал генераций: каждая генерация платная, поэтому каждый вызов модели
// пишется строкой JSON в generations.jsonl в папке данных приложения.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GenerateRequest, GenerateResult, ImageProvider } from '../providers/types.ts';

export interface LedgerEntry {
  at: string;
  provider: string;
  model: string;
  aspectRatio: string;
  imageSize: string;
  ok: boolean;
  elapsedMs: number;
  purpose?: string;
  error?: string;
}

export function appDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'canvaaaas');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'canvaaaas');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'canvaaaas');
}

export function ledgerPath(): string {
  return join(appDataDir(), 'generations.jsonl');
}

export async function readLedger(): Promise<LedgerEntry[]> {
  try {
    const text = await readFile(ledgerPath(), 'utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  } catch {
    return [];
  }
}

async function append(entry: LedgerEntry): Promise<void> {
  await mkdir(appDataDir(), { recursive: true });
  await appendFile(ledgerPath(), JSON.stringify(entry) + '\n');
}

/** Обёртка над провайдером, которая записывает каждый вызов в журнал */
export function withLedger(provider: ImageProvider, purpose?: string): ImageProvider {
  return {
    ...provider,
    outputSize: provider.outputSize.bind(provider),
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const started = Date.now();
      const base = {
        at: new Date().toISOString(),
        provider: provider.id,
        model: provider.model,
        aspectRatio: req.aspectRatio,
        imageSize: req.imageSize,
        purpose,
      };
      try {
        const result = await provider.generate(req);
        await append({ ...base, ok: true, elapsedMs: result.elapsedMs });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await append({ ...base, ok: false, elapsedMs: Date.now() - started, error });
        throw err;
      }
    },
  };
}

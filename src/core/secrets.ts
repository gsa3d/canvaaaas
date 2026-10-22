// Ключ laozhang.ai. Значение ключа нигде не выводится и не попадает в тексты ошибок.
// macOS — Связка ключей через /usr/bin/security (ключ идёт через stdin, не в аргументах процесса);
// Windows — файл, зашифрованный средствами системы (Electron safeStorage);
// переменная окружения LAOZHANG_API_KEY, если задана, главнее всего.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SECURITY = '/usr/bin/security';

export const KEYCHAIN_SERVICE = 'canvaaaas-laozhang';
export const KEYCHAIN_ACCOUNT = 'api_key';

export interface KeyStore {
  /** Ключ или null, если его нет */
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  clear(): Promise<void>;
}

export function validateKey(raw: string): string {
  const key = raw.trim();
  if (key.length < 10 || key.length > 400 || /\s/.test(key)) throw new Error('Это не похоже на ключ: без пробелов, от 10 символов');
  return key;
}

export function keychainStore(service = KEYCHAIN_SERVICE): KeyStore {
  return {
    async get() {
      try {
        const { stdout } = await execFileAsync(SECURITY, ['find-generic-password', '-s', service, '-a', KEYCHAIN_ACCOUNT, '-w']);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
    async set(raw) {
      const key = validateKey(raw);
      // С -w без значения security дважды спрашивает пароль (ввод и подтверждение) — отвечаем через stdin
      await new Promise<void>((resolve, reject) => {
        const child = spawn(SECURITY, ['add-generic-password', '-U', '-s', service, '-a', KEYCHAIN_ACCOUNT, '-w'], {
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('Не удалось сохранить ключ в Связку ключей'))));
        child.stdin.end(`${key}\n${key}\n`);
      });
    },
    async clear() {
      await execFileAsync(SECURITY, ['delete-generic-password', '-s', service, '-a', KEYCHAIN_ACCOUNT]).catch(() => undefined);
    },
  };
}

export interface Encryptor {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/** Файл, зашифрованный средствами системы: на Windows — DPAPI текущего пользователя */
export function encryptedFileStore(file: string, crypto: Encryptor): KeyStore {
  return {
    async get() {
      try {
        if (!crypto.available()) return null;
        return crypto.decrypt(await readFile(file)).trim() || null;
      } catch {
        return null;
      }
    },
    async set(raw) {
      const key = validateKey(raw);
      if (!crypto.available()) throw new Error('Система не даёт зашифровать ключ на этом компьютере');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, crypto.encrypt(key), { mode: 0o600 });
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

/** Только переменная окружения — для разработки там, где нет ни Связки, ни Electron */
export function envOnlyStore(): KeyStore {
  return {
    get: async () => null,
    set: async () => {
      throw new Error('Здесь ключ задаётся переменной окружения LAOZHANG_API_KEY');
    },
    clear: async () => undefined,
  };
}

/** Переменная окружения LAOZHANG_API_KEY главнее сохранённого ключа */
export function withEnv(store: KeyStore): KeyStore {
  return {
    get: async () => process.env.LAOZHANG_API_KEY?.trim() || store.get(),
    set: (key) => store.set(key),
    clear: () => store.clear(),
  };
}

/** Хранилище по умолчанию вне Electron: Связка ключей на macOS, иначе только переменная окружения */
export function defaultKeyStore(): KeyStore {
  return withEnv(process.platform === 'darwin' ? keychainStore() : envOnlyStore());
}

/** Для CLI: ключ или понятная ошибка */
export async function getLaozhangKey(): Promise<string> {
  const key = await defaultKeyStore().get();
  if (key) return key;
  throw new Error(
    process.platform === 'darwin'
      ? `Нет ключа laozhang.ai. Добавьте его в приложении или командой: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`
      : 'Нет ключа laozhang.ai. Задайте переменную окружения LAOZHANG_API_KEY',
  );
}

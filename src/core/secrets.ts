// Ключ laozhang.ai: переменная окружения или Связка ключей macOS.
// Значение ключа нигде не выводится и не попадает в тексты ошибок.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = 'canvaaaas-laozhang';
export const KEYCHAIN_ACCOUNT = 'api_key';

export async function getLaozhangKey(): Promise<string> {
  const fromEnv = process.env.LAOZHANG_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT,
        '-w',
      ]);
      const key = stdout.trim();
      if (key) return key;
    } catch {
      // Записи нет — ниже объясним, как её завести
    }
  }

  throw new Error(
    process.platform === 'darwin'
      ? `Нет ключа laozhang.ai. Положите его в Связку ключей: security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`
      : 'Нет ключа laozhang.ai. Задайте переменную окружения LAOZHANG_API_KEY',
  );
}

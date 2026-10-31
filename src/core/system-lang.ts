// Язык системы для сервера без Electron и CLI: CANVAAAAS_LANG, на macOS — первый язык системы, иначе локаль процесса
import { execFileSync } from 'node:child_process';
import { langOf, type Lang } from '../shared/i18n.ts';

export function systemLang(): Lang {
  const forced = process.env.CANVAAAAS_LANG;
  if (forced) return langOf(forced);
  if (process.platform === 'darwin') {
    try {
      // ( "ru-RU", "en-US" )
      const out = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000 });
      const first = /[A-Za-z][\w-]*/.exec(out)?.[0];
      if (first) return langOf(first);
    } catch {
      // нет настройки — по локали процесса
    }
  }
  return langOf(process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
}

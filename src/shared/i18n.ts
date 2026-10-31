// Язык интерфейса: английский, а русский — если система по-русски или он выбран в настройках.
// Тексты пишутся прямо в коде парой: L('по-русски', 'in English'). Язык читается в момент вызова,
// поэтому L() на уровне модуля сработает с языком по умолчанию — такие тексты считать в функциях.

export type Lang = 'en' | 'ru';
/** Выбор в настройках: как в системе или явно */
export type LangChoice = 'system' | Lang;
export const LANG_CHOICES: readonly LangChoice[] = ['system', 'en', 'ru'];

/** Язык по локали вида ru, ru-RU, ru_RU.UTF-8 */
export function langOf(locale: string | null | undefined): Lang {
  return /^ru(?:$|[-_.@])/i.test(locale?.trim() ?? '') ? 'ru' : 'en';
}

/** Язык из выбора в настройках и языка системы */
export function resolveLang(choice: unknown, system: Lang): Lang {
  return choice === 'en' || choice === 'ru' ? choice : system;
}

let current: Lang = langOf(Intl.DateTimeFormat().resolvedOptions().locale);

export function setLang(lang: Lang): void {
  current = lang;
}

export function lang(): Lang {
  return current;
}

/** Текст на языке интерфейса */
export function L(ru: string, en: string): string {
  return current === 'ru' ? ru : en;
}

/** Слово при числе: русские формы для 1, 2–4 и 5 и английские для 1 и остального */
export function plural(n: number, ru: readonly [one: string, few: string, many: string], en: readonly [one: string, other: string]): string {
  if (current !== 'ru') return Math.abs(n) === 1 ? en[0] : en[1];
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return ru[0];
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return ru[1];
  return ru[2];
}

/** Число с дробной частью: по-русски через запятую */
export function decimal(x: number, digits: number): string {
  const s = x.toFixed(digits);
  return current === 'ru' ? s.replace('.', ',') : s;
}

/** Локаль для дат и чисел */
export function locale(): string {
  return current === 'ru' ? 'ru-RU' : 'en-US';
}

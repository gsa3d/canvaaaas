import { afterEach, describe, expect, it } from 'vitest';
import { decimal, L, lang, langOf, plural, resolveLang, setLang } from '../src/shared/i18n.ts';
import { Session } from '../src/server/session.ts';
import type { KeyStore } from '../src/core/secrets.ts';

const keys: KeyStore = { get: async () => null, set: async () => undefined, clear: async () => undefined };

describe('язык интерфейса', () => {
  afterEach(() => setLang('ru'));

  it('русский — только при русской локали', () => {
    expect(['ru', 'ru-RU', 'ru_RU.UTF-8', 'RU'].map(langOf)).toEqual(['ru', 'ru', 'ru', 'ru']);
    expect(['en-US', 'de', 'uk-UA', 'rus', '', undefined].map(langOf)).toEqual(['en', 'en', 'en', 'en', 'en', 'en']);
    expect(resolveLang('system', 'ru')).toBe('ru');
    expect(resolveLang('en', 'ru')).toBe('en');
    expect(resolveLang('fr', 'en')).toBe('en');
  });

  it('тексты, числа и склонения', () => {
    setLang('en');
    expect(L('Слой', 'Layer')).toBe('Layer');
    expect([1, 2, 5, 21].map((n) => plural(n, ['слой', 'слоя', 'слоёв'], ['layer', 'layers']))).toEqual(['layer', 'layers', 'layers', 'layers']);
    expect(decimal(1.25, 1)).toBe('1.3');
    setLang('ru');
    expect(L('Слой', 'Layer')).toBe('Слой');
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, ['слой', 'слоя', 'слоёв'], ['layer', 'layers']))).toEqual([
      'слой',
      'слоя',
      'слоёв',
      'слоёв',
      'слой',
      'слоя',
      'слоёв',
    ]);
    expect(decimal(1.25, 1)).toBe('1,3');
  });

  it('язык из настроек главнее системного и меняется сразу', async () => {
    const s = new Session('mock', keys, { systemLang: 'ru' });
    expect(s.language()).toEqual({ lang: 'ru', choice: 'system', system: 'ru' });
    await s.setLanguage('en');
    expect(lang()).toBe('en');
    expect(s.language().choice).toBe('en');
    expect(() => s.setStyle('x')).toThrow('No document open');
    await s.setLanguage('system');
    expect(lang()).toBe('ru');
    await expect(s.setLanguage('fr' as 'en')).rejects.toThrow('Нет такого языка');
  });
});

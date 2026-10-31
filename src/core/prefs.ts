// Настройки интерфейса (модель, разрешение, кисть, режимы инструментов): prefs.json в папке данных приложения.
// Не в localStorage окна: сервер приложения каждый запуск берёт свободный порт, у окна другой адрес — и память браузера пустая.
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './image-file.ts';
import { L } from '../shared/i18n.ts';

/** Настройки — короткие значения формы и инструментов, не данные */
const MAX_KEYS = 100;
const MAX_VALUE = 4096;

export class Prefs {
  private readonly dir: string;
  private values: Record<string, unknown> = {};
  /** Записи на диск идут по очереди */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async load(dir: string): Promise<Prefs> {
    const prefs = new Prefs(dir);
    try {
      const data = JSON.parse(await readFile(prefs.path(), 'utf8')) as unknown;
      if (data && typeof data === 'object' && !Array.isArray(data)) prefs.values = data as Record<string, unknown>;
    } catch {
      // настроек ещё нет или файл испорчен — всё по умолчанию
    }
    return prefs;
  }

  all(): Record<string, unknown> {
    return { ...this.values };
  }

  set(key: string, value: unknown): Promise<void> {
    if (!/^[a-z0-9-]{1,64}$/.test(key)) throw new Error(L('Нет такой настройки', 'No such setting'));
    if (JSON.stringify(value ?? null).length > MAX_VALUE) throw new Error(L('Слишком длинная настройка', 'Setting is too long'));
    if (!(key in this.values) && Object.keys(this.values).length >= MAX_KEYS) throw new Error(L('Слишком много настроек', 'Too many settings'));
    this.values = { ...this.values, [key]: value ?? null };
    const snapshot = JSON.stringify(this.values, null, 2);
    const next = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await writeFileAtomic(this.path(), Buffer.from(snapshot));
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private path(): string {
    return join(this.dir, 'prefs.json');
  }
}

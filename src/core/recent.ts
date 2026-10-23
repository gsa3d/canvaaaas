// Недавние файлы: список в recent.json и миниатюры в thumbs/ в папке данных приложения.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './image-file.ts';

export interface RecentEntry {
  id: string;
  path: string;
  name: string;
  width: number;
  height: number;
  openedAt: string;
}

export const RECENT_LIMIT = 12;

export function recentId(path: string): string {
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

export class RecentFiles {
  private readonly dir: string;
  private entries: RecentEntry[] = [];
  /** Записи на диск идут по очереди */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async load(dir: string): Promise<RecentFiles> {
    const recent = new RecentFiles(dir);
    try {
      const data = JSON.parse(await readFile(recent.listPath(), 'utf8')) as RecentEntry[];
      if (Array.isArray(data)) recent.entries = data.filter((e) => typeof e?.path === 'string').slice(0, RECENT_LIMIT);
    } catch {
      // списка ещё нет или он испорчен — начинаем с пустого
    }
    return recent;
  }

  list(): RecentEntry[] {
    return [...this.entries];
  }

  get(id: string): RecentEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  thumbPath(id: string): string {
    return join(this.dir, 'thumbs', `${id}.jpg`);
  }

  /** Файл открыт или сохранён: он поднимается в начало списка, миниатюра обновляется */
  add(entry: Omit<RecentEntry, 'id' | 'openedAt'>, thumb: Buffer): Promise<void> {
    const id = recentId(entry.path);
    const dropped = this.entries.filter((e) => e.id !== id).slice(RECENT_LIMIT - 1);
    this.entries = [{ ...entry, id, openedAt: new Date().toISOString() }, ...this.entries.filter((e) => e.id !== id)].slice(0, RECENT_LIMIT);
    return this.persist(async () => {
      await mkdir(join(this.dir, 'thumbs'), { recursive: true });
      await writeFileAtomic(this.thumbPath(id), thumb);
      await Promise.all(dropped.map((e) => rm(this.thumbPath(e.id), { force: true })));
    });
  }

  remove(id: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.id !== id);
    return this.persist(() => rm(this.thumbPath(id), { force: true }));
  }

  clear(): Promise<void> {
    this.entries = [];
    return this.persist(() => rm(join(this.dir, 'thumbs'), { recursive: true, force: true }));
  }

  private persist(extra: () => Promise<unknown>): Promise<void> {
    const snapshot = JSON.stringify(this.entries, null, 2);
    const next = this.chain.then(async () => {
      await mkdir(this.dir, { recursive: true });
      await extra();
      await writeFileAtomic(this.listPath(), Buffer.from(snapshot));
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private listPath(): string {
    return join(this.dir, 'recent.json');
  }
}

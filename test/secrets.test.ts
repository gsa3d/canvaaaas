import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encryptedFileStore, keychainStore } from '../src/core/secrets.ts';

const KEY = 'test-key-0123456789abcdef';

describe('хранилища ключа', () => {
  it.runIf(process.platform === 'darwin')('Связка ключей: сохранить, прочитать, удалить (отдельная тестовая запись)', async () => {
    const store = keychainStore('canvaaaas-test-store');
    await store.set(KEY);
    expect(await store.get()).toBe(KEY);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('зашифрованный файл: на диске нет ключа открытым текстом', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvaaaas-'));
    const file = join(dir, 'key.bin');
    const store = encryptedFileStore(file, {
      available: () => true,
      encrypt: (t) => Buffer.from([...Buffer.from(t)].map((b) => b ^ 0x5a)),
      decrypt: (d) => Buffer.from([...d].map((b) => b ^ 0x5a)).toString(),
    });
    await store.set(` ${KEY} `);
    expect(await store.get()).toBe(KEY);
    expect((await readFile(file)).toString()).not.toContain(KEY);
    await store.clear();
    expect(await store.get()).toBeNull();
    await expect(store.set('с пробелом внутри')).rejects.toThrow();
    await rm(dir, { recursive: true });
  });
});

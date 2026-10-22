// Оболочка Electron: поднимает сервер приложения на 127.0.0.1 (порт любой свободный)
// и открывает окно с интерфейсом. Вся работа с картинками — в сервере, окно только показывает.
import { join } from 'node:path';
import { app, BrowserWindow, Menu, safeStorage, shell, type MenuItemConstructorOptions } from 'electron';
import { encryptedFileStore, keychainStore, withEnv } from '../core/secrets.ts';
import { COMMAND_EVENT, type AppCommand } from '../shared/api.ts';
import { startServer } from '../server/app.ts';
import { Session } from '../server/session.ts';

if (!app.requestSingleInstanceLock()) app.quit();

// Меню по-русски. Пункты шлют команду в окно; их сочетания клавиш только показываются
// (registerAccelerator: false), а нажатия обрабатывает интерфейс — так нигде нет двойного срабатывания.
// «Отменить» и «Повторить» зарегистрированы по-настоящему: на macOS без них не работает отмена в полях ввода,
// а холст, когда фокус не в поле, перехватывает эти клавиши раньше меню.
function buildMenu(win: BrowserWindow): void {
  const mac = process.platform === 'darwin';
  const send = (command: AppCommand) =>
    void win.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent(${JSON.stringify(COMMAND_EVENT)}, { detail: ${JSON.stringify(command)} }))`,
    );
  const item = (label: string, command: AppCommand, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send(command),
  });
  const settings = item('Настройки…', 'settings', 'CmdOrCtrl+,');
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: 'canvaaaas',
            submenu: [
              { role: 'about', label: 'О canvaaaas' },
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'hide', label: 'Скрыть canvaaaas' },
              { role: 'hideOthers', label: 'Скрыть остальные' },
              { role: 'unhide', label: 'Показать все' },
              { type: 'separator' },
              { role: 'quit', label: 'Завершить canvaaaas' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'Файл',
      submenu: [
        item('Открыть картинку…', 'open', 'CmdOrCtrl+O'),
        item('Новый холст…', 'new', 'CmdOrCtrl+N'),
        { type: 'separator' },
        item('Сохранить PNG…', 'export', 'CmdOrCtrl+Shift+E'),
        ...(mac ? [] : [{ type: 'separator' } as const, settings, { type: 'separator' } as const, { role: 'quit', label: 'Выход' } as const]),
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { label: 'Отменить', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Повторить', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать всё' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        item('Вписать в окно', 'zoom-fit', 'CmdOrCtrl+0'),
        item('Масштаб 100%', 'zoom-100', 'CmdOrCtrl+1'),
        item('Масштаб 50%', 'zoom-50', 'CmdOrCtrl+2'),
        item('Увеличить', 'zoom-in', 'CmdOrCtrl+='),
        item('Уменьшить', 'zoom-out', 'CmdOrCtrl+-'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Во весь экран' },
        { role: 'reload', label: 'Перезагрузить окно' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'zoom', label: 'Изменить размер' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Ключ: на macOS — Связка ключей, на Windows — файл, зашифрованный системой для текущего пользователя
  const keys = withEnv(
    process.platform === 'darwin'
      ? keychainStore()
      : encryptedFileStore(join(app.getPath('userData'), 'laozhang-key.bin'), {
          available: () => safeStorage.isEncryptionAvailable(),
          encrypt: (text) => safeStorage.encryptString(text),
          decrypt: (data) => safeStorage.decryptString(data),
        }),
  );
  const session = new Session(process.env.CANVAAAAS_PROVIDER === 'mock' ? 'mock' : 'laozhang', keys);
  await session.init();
  const server = await startServer({ session, port: 0, staticDir: join(app.getAppPath(), 'dist', 'renderer') });

  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
    title: 'canvaaaas',
    backgroundColor: '#505255',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  buildMenu(win);
  // Окно живёт только на своём сервере; внешние ссылки — в браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(server.url)) event.preventDefault();
  });
  await win.loadURL(server.url);

  if (process.argv.includes('--smoke')) {
    // Проверка сборки: интерфейс отрисовался и достучался до сервера
    const check = await win.webContents.executeJavaScript(
      `new Promise((r) => setTimeout(async () => {
        const res = await fetch('/api/state');
        r({ ui: !!document.querySelector('.app'), api: res.ok, key: (await res.json()).hasKey });
      }, 1500))`,
    );
    console.log(`SMOKE ${check.ui && check.api ? 'OK' : 'FAIL'}: ${server.url}, интерфейс ${check.ui}, API ${check.api}, ключ ${check.key ? 'есть' : 'нет'}`);
    app.exit(check.ui && check.api ? 0 : 1);
  }

  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('before-quit', () => void server.close());
});

app.on('window-all-closed', () => app.quit());

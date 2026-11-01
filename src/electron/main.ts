// Оболочка Electron: поднимает сервер приложения на 127.0.0.1 (порт любой свободный)
// и открывает окно с интерфейсом. Вся работа с картинками — в сервере, окно только показывает.
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, safeStorage, shell, type MenuItemConstructorOptions } from 'electron';
import { encodeImage, formatOf, IMAGE_EXTENSIONS } from '../core/image-file.ts';
import { isProjectPath, PROJECT_EXTENSION } from '../core/project.ts';
import { Prefs } from '../core/prefs.ts';
import { RecentFiles } from '../core/recent.ts';
import { Segmenter } from '../core/segment.ts';
import { modelFiles, modelInstalled } from '../core/segment-model.ts';
import { encryptedFileStore, keychainStore, keysFrom } from '../core/secrets.ts';
import { COMMAND_EVENT, type AppCommand } from '../shared/api.ts';
import { startServer } from '../server/app.ts';
import { Session, type Host } from '../server/session.ts';
import { L, lang, langOf } from '../shared/i18n.ts';

// Самопроверка — со своим профилем: так она идёт и рядом с открытым canvaaaas и не будит его окно
if (process.argv.includes('--smoke')) app.setPath('userData', join(tmpdir(), `canvaaaas-smoke-${process.pid}`));
if (!app.requestSingleInstanceLock()) app.quit();

// Файл, который система просит открыть: двойной щелчок по .caaa в Finder, перетаскивание на значок в Dock.
// На macOS событие приходит и до запуска окна — тогда файл ждёт, пока окно не будет готово
let openFile: ((path: string) => void) | null = null;
const waitingFiles: string[] = [];
app.on('open-file', (event, path) => {
  event.preventDefault();
  if (openFile) openFile(path);
  else waitingFiles.push(path);
});

/** На Windows файл приходит в аргументах запуска */
function fileArg(argv: string[]): string | undefined {
  return argv.slice(1).find((a) => !a.startsWith('-') && (isProjectPath(a) || formatOf(a)) && existsSync(a));
}

// Меню на языке интерфейса. Пункты шлют команду в окно; их сочетания клавиш только показываются
// (registerAccelerator: false), а нажатия обрабатывает интерфейс — так нигде нет двойного срабатывания.
// «Отменить» и «Повторить» зарегистрированы по-настоящему: на macOS без них не работает отмена в полях ввода,
// а холст, когда фокус не в поле, перехватывает эти клавиши раньше меню.
function buildMenu(win: BrowserWindow, session: Session): void {
  const mac = process.platform === 'darwin';
  const home = app.getPath('home');
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
  const settings = item(L('Настройки…', 'Settings…'), 'settings', 'CmdOrCtrl+,');
  const recent = session.recentFiles();
  const hasDoc = session.doc !== null;
  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: 'canvaaaas',
            submenu: [
              { role: 'about', label: L('О canvaaaas', 'About canvaaaas') },
              { type: 'separator' },
              settings,
              { type: 'separator' },
              { role: 'hide', label: L('Скрыть canvaaaas', 'Hide canvaaaas') },
              { role: 'hideOthers', label: L('Скрыть остальные', 'Hide Others') },
              { role: 'unhide', label: L('Показать все', 'Show All') },
              { type: 'separator' },
              { role: 'quit', label: L('Завершить canvaaaas', 'Quit canvaaaas') },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: L('Файл', 'File'),
      submenu: [
        item(L('Открыть…', 'Open…'), 'open', 'CmdOrCtrl+O'),
        {
          label: L('Открыть недавние', 'Open Recent'),
          submenu: [
            ...(recent.length
              ? recent.map((e) => ({
                  label: e.name,
                  sublabel: dirname(e.path).replace(home, '~'),
                  toolTip: e.path,
                  click: () => send(`open-recent:${e.id}`),
                }))
              : [{ label: L('Пока пусто', 'Nothing yet'), enabled: false }]),
            { type: 'separator' },
            { label: L('Очистить список', 'Clear Menu'), enabled: recent.length > 0, click: () => void session.clearRecent() },
          ],
        },
        item(L('Новый холст…', 'New Canvas…'), 'new', 'CmdOrCtrl+N'),
        { type: 'separator' },
        { ...item(L('Сохранить', 'Save'), 'save', 'CmdOrCtrl+S'), enabled: hasDoc },
        { ...item(L('Сохранить как…', 'Save As…'), 'save-as', 'CmdOrCtrl+Shift+S'), enabled: hasDoc },
        { ...item(L('Экспортировать картинку…', 'Export Image…'), 'export', 'CmdOrCtrl+Shift+E'), enabled: hasDoc },
        ...(mac ? [] : [{ type: 'separator' } as const, settings, { type: 'separator' } as const, { role: 'quit', label: L('Выход', 'Exit') } as const]),
      ],
    },
    {
      label: L('Правка', 'Edit'),
      submenu: [
        { label: L('Отменить', 'Undo'), accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: L('Повторить', 'Redo'), accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut', label: L('Вырезать', 'Cut') },
        { role: 'copy', label: L('Копировать', 'Copy') },
        { role: 'paste', label: L('Вставить', 'Paste') },
        { role: 'selectAll', label: L('Выбрать всё', 'Select All') },
        { type: 'separator' },
        { ...item(L('Снять выделение', 'Deselect'), 'deselect', 'CmdOrCtrl+D'), enabled: hasDoc },
      ],
    },
    {
      label: L('Слой', 'Layer'),
      submenu: [
        { ...item(L('Слой из выделения', 'Layer via Copy'), 'save-object', 'CmdOrCtrl+J'), enabled: hasDoc },
        { ...item(L('Вырезать в слой', 'Layer via Cut'), 'cut-object', 'CmdOrCtrl+Shift+J'), enabled: hasDoc },
        { type: 'separator' },
        { ...item(L('Сгруппировать слои', 'Group Layers'), 'group-layers', 'CmdOrCtrl+G'), enabled: hasDoc },
        { ...item(L('Разгруппировать', 'Ungroup'), 'ungroup', 'CmdOrCtrl+Shift+G'), enabled: hasDoc },
        { type: 'separator' },
        { ...item(L('Объединить слои', 'Merge Layers'), 'merge-layers', 'CmdOrCtrl+E'), enabled: hasDoc },
        { ...item(L('Влить в фон', 'Merge into Background'), 'merge-down'), enabled: hasDoc },
        { type: 'separator' },
        { ...item(L('Свести все слои', 'Flatten All Layers'), 'flatten'), enabled: hasDoc },
      ],
    },
    {
      label: L('Вид', 'View'),
      submenu: [
        item(L('Вписать в окно', 'Fit to Window'), 'zoom-fit', 'CmdOrCtrl+0'),
        item(L('Масштаб 100%', 'Zoom 100%'), 'zoom-100', 'CmdOrCtrl+1'),
        item(L('Масштаб 50%', 'Zoom 50%'), 'zoom-50', 'CmdOrCtrl+2'),
        item(L('Увеличить', 'Zoom In'), 'zoom-in', 'CmdOrCtrl+='),
        item(L('Уменьшить', 'Zoom Out'), 'zoom-out', 'CmdOrCtrl+-'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: L('Во весь экран', 'Toggle Full Screen') },
        { role: 'reload', label: L('Перезагрузить окно', 'Reload Window') },
        { role: 'toggleDevTools', label: L('Инструменты разработчика', 'Developer Tools') },
      ],
    },
    {
      label: L('Окно', 'Window'),
      submenu: [
        { role: 'minimize', label: L('Свернуть', 'Minimize') },
        { role: 'zoom', label: L('Изменить размер', 'Zoom') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Ключи: на macOS — Связка ключей, на Windows — файлы, зашифрованные системой для текущего пользователя
  const keys = keysFrom((place) =>
    process.platform === 'darwin'
      ? keychainStore(place.keychain)
      : encryptedFileStore(join(app.getPath('userData'), place.file), {
          available: () => safeStorage.isEncryptionAvailable(),
          encrypt: (text) => safeStorage.encryptString(text),
          decrypt: (data) => safeStorage.decryptString(data),
        }),
  );
  const smoke = process.argv.includes('--smoke');
  // Самопроверка не трогает настоящие список недавних и настройки
  const smokeDir = smoke ? await mkdtemp(join(tmpdir(), 'canvaaaas-smoke-')) : null;
  const recent = await RecentFiles.load(smokeDir ?? app.getPath('userData'));
  const prefs = await Prefs.load(smokeDir ?? app.getPath('userData'));
  // Язык системы — первый в её списке; CANVAAAAS_LANG=en|ru — проверить другой
  const systemLang = langOf(process.env.CANVAAAAS_LANG || app.getPreferredSystemLanguages()[0] || app.getLocale());
  const session = new Session(process.env.CANVAAAAS_PROVIDER === 'mock' ? 'mock' : 'live', keys, { recent, prefs, systemLang });
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
  session.host = nativeHost(win);
  // Меню перестраивается, только когда меняется то, что в нём показано
  let menuKey = '';
  const sync = () => {
    if (win.isDestroyed()) return;
    const key = JSON.stringify([lang(), session.doc !== null, session.recentFiles().map((e) => e.id)]);
    if (key !== menuKey) {
      menuKey = key;
      buildMenu(win, session);
    }
    if (process.platform === 'darwin') {
      win.setDocumentEdited(session.dirty);
      win.setRepresentedFilename(session.filePath ?? '');
    }
  };
  sync();
  session.onChange(sync);

  // Несохранённые правки и задачи в очереди: перед закрытием окна (и выходом) спросить
  let closeConfirmed = false;
  win.on('close', (event) => {
    if (closeConfirmed || !session.needsConfirm()) return;
    event.preventDefault();
    session
      .confirmClose()
      .then((ok) => {
        if (!ok) return;
        closeConfirmed = true;
        win.close();
      })
      .catch((err: unknown) => dialog.showErrorBox(L('Не удалось сохранить', 'Could not save'), err instanceof Error ? err.message : String(err)));
  });

  // Окно живёт только на своём сервере; внешние ссылки — в браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(server.url)) event.preventDefault();
  });
  await win.loadURL(server.url);

  if (smokeDir) {
    // Проверка сборки: интерфейс отрисовался и достучался до сервера, файл открывается и сохраняется,
    // проект .caaa сохраняется со слоем и открывается обратно, закрытие окна с несохранённым спрашивает
    const check = await win.webContents.executeJavaScript(
      `new Promise((r) => setTimeout(async () => {
        const res = await fetch('/api/state');
        r({ ui: !!document.querySelector('.app'), api: res.ok, key: (await res.json()).hasKey });
      }, 1500))`,
    );
    const asked: string[] = [];
    session.host = {
      chooseOpen: async () => null,
      chooseSave: async () => join(smokeDir, `smoke.${PROJECT_EXTENSION}`),
      // Всегда «Отмена»
      ask: async ({ message, buttons }) => {
        asked.push(message);
        return buttons.length - 1;
      },
    };
    const patch = (id: string) => {
      const layer = Buffer.alloc(16 * 16 * 4, 255);
      session.doc!.addPatch({ id, rect: { x: 8, y: 8, width: 16, height: 16 }, layer, prompt: id, jobId: id, variant: 0, createdAt: '' });
    };
    let files = false;
    let project = false;
    let close = false;
    try {
      const path = join(smokeDir, 'smoke.png');
      await writeFile(path, await encodeImage({ data: Buffer.alloc(64 * 48 * 3, 200), width: 64, height: 48, channels: 3 }, 'png'));
      await session.openPath(path);
      files = (await session.save()) === path && (await stat(path)).size > 0 && session.recentFiles()[0]?.path === path;
      patch('a');
      const saved = await session.saveAs();
      await session.openPath(saved!);
      project = saved?.endsWith(`.${PROJECT_EXTENSION}`) === true && session.doc?.patches.length === 1 && !session.dirty;
      patch('b');
      win.close();
      await new Promise((r) => setTimeout(r, 300));
      close = !win.isDestroyed() && asked.some((m) => m.startsWith(L('Сохранить изменения', 'Save changes')));
    } catch (err) {
      console.log(L(`SMOKE файлы: ${err instanceof Error ? err.message : String(err)}`, `SMOKE files: ${err instanceof Error ? err.message : String(err)}`));
    }
    await rm(smokeDir, { recursive: true, force: true });
    // Выделение объектов: onnxruntime загрузился вместе с сервером; если веса скачаны — где считает кодировщик
    let sam = L('модель не скачана', 'model not downloaded');
    if (modelInstalled()) {
      const { encoder, decoder } = modelFiles();
      sam = await Segmenter.load(encoder, decoder).then(
        (s) => s.backend,
        (err: unknown) => L(`ошибка: ${err instanceof Error ? err.message : String(err)}`, `error: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    const ok = check.ui && check.api && files && project && close;
    console.log(
      L(`SMOKE ${ok ? 'OK' : 'FAIL'}: ${server.url}, интерфейс ${check.ui}, API ${check.api}, открытие и сохранение ${files}, `, `SMOKE ${ok ? 'OK' : 'FAIL'}: ${server.url}, UI ${check.ui}, API ${check.api}, open and save ${files}, `) +
        L(`проект .caaa ${project}, вопрос при закрытии ${close}, ключ ${check.key ? 'есть' : 'нет'}, выделение объектов ${sam}`, `.caaa project ${project}, prompt on close ${close}, key ${check.key ? 'yes' : 'no'}, object selection ${sam}`),
    );
    app.exit(ok ? 0 : 1);
    return;
  }

  openFile = (path) => {
    if (win.isMinimized()) win.restore();
    win.focus();
    session.openPath(path).catch((err: unknown) => dialog.showErrorBox(L('Не удалось открыть файл', 'Could not open the file'), err instanceof Error ? err.message : String(err)));
  };
  const launched = fileArg(process.argv);
  for (const path of [...waitingFiles.splice(0), ...(launched ? [launched] : [])]) openFile(path);

  app.on('second-instance', (_event, argv) => {
    if (win.isMinimized()) win.restore();
    win.focus();
    const path = fileArg(argv);
    if (path) openFile?.(path);
  });
  // Не before-quit: выход ещё может отмениться вопросом о несохранённых правках
  app.on('will-quit', () => void server.close());
});

const projectFilter = () => ({ name: L('Проект canvaaaas', 'canvaaaas project'), extensions: [PROJECT_EXTENSION] });
const IMAGE_FILTERS = [
  { name: 'PNG', extensions: ['png'] },
  { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP', extensions: ['webp'] },
  { name: 'TIFF', extensions: ['tif', 'tiff'] },
];

function nativeHost(win: BrowserWindow): Host {
  return {
    async chooseOpen() {
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: L('Картинки и проекты canvaaaas', 'Images and canvaaaas projects'), extensions: [...IMAGE_EXTENSIONS, PROJECT_EXTENSION] }],
      });
      return res.canceled ? null : (res.filePaths[0] ?? null);
    },
    async chooseSave(defaultPath, { message, project = true } = {}) {
      // Первым — фильтр расширения из имени по умолчанию: Windows ставит выбранным первый
      const ext = extname(defaultPath).slice(1).toLowerCase();
      const filters = [...(project ? [projectFilter()] : []), ...IMAGE_FILTERS].sort(
        (a, b) => Number(b.extensions.includes(ext)) - Number(a.extensions.includes(ext)),
      );
      const res = await dialog.showSaveDialog(win, {
        defaultPath,
        message,
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        filters,
      });
      return res.canceled ? null : (res.filePath ?? null);
    },
    async ask({ message, detail, buttons }) {
      const res = await dialog.showMessageBox(win, { type: 'warning', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 });
      return res.response;
    },
  };
}

app.on('window-all-closed', () => app.quit());

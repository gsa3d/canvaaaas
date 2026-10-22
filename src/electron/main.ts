// Оболочка Electron: поднимает сервер приложения на 127.0.0.1 (порт любой свободный)
// и открывает окно с интерфейсом. Вся работа с картинками — в сервере, окно только показывает.
import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { startServer } from '../server/app.ts';
import { Session } from '../server/session.ts';

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  const session = new Session(process.env.CANVAAAAS_PROVIDER === 'mock' ? 'mock' : 'laozhang');
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
      `new Promise((r) => setTimeout(async () => r({ ui: !!document.querySelector('.app'), api: (await fetch('/api/state')).ok }), 1500))`,
    );
    console.log(`SMOKE ${check.ui && check.api ? 'OK' : 'FAIL'}: ${server.url}, интерфейс ${check.ui}, API ${check.api}`);
    app.exit(check.ui && check.api ? 0 : 1);
  }

  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('before-quit', () => void server.close());
});

app.on('window-all-closed', () => app.quit());

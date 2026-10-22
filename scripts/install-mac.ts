// Кладёт собранный canvaaaas.app в «Программы» на место старой версии (npm run install:mac).
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const src = `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/canvaaaas.app`;
const dst = '/Applications/canvaaaas.app';

if (!existsSync(src)) {
  console.error(`Нет ${src}: сначала соберите приложение (npm run app:mac)`);
  process.exit(1);
}
try {
  execFileSync('pgrep', ['-f', `${dst}/Contents/MacOS/`], { stdio: 'ignore' });
  console.error('canvaaaas сейчас открыт — закройте его и повторите');
  process.exit(1);
} catch {
  // Не запущен — можно заменять
}
// Подписи разработчика нет — подписываем пакет целиком «на месте» (ad-hoc), иначе macOS считает его повреждённым
execFileSync('codesign', ['--force', '--deep', '--sign', '-', src], { stdio: 'inherit' });
rmSync(dst, { recursive: true, force: true });
execFileSync('ditto', [src, dst]);
console.log(`Готово: ${dst}. Запускайте из Launchpad, Spotlight или папки «Программы».`);

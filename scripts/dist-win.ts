// Установщик для Windows (npm run dist:win). На Windows — обычная сборка. На Mac — в копии проекта work/win-build:
// приложению нужны Windows-версии sharp, а поставить их в node_modules проекта нельзя — сломается разработка на Mac.
// Копия ставит зависимости для win32-x64 (их скрипты не нужны: всё нужное уже в пакетах), интерфейс и main
// собираются здесь же, готовый установщик кладётся в release/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const run = (cmd: string, args: string[], cwd = '.', env: NodeJS.ProcessEnv = {}) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
const builder = ['electron-builder', '--win', 'nsis', '--x64', '--publish', 'never'];

run('npm', ['run', 'build']);
if (process.platform === 'win32') {
  run('npx', builder);
  process.exit(0);
}

const stage = 'work/win-build';
mkdirSync(stage, { recursive: true });
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const file of files) {
  if (!existsSync(file)) continue;
  mkdirSync(join(stage, dirname(file)), { recursive: true });
  copyFileSync(file, join(stage, file));
}
rmSync(join(stage, 'dist'), { recursive: true, force: true });
cpSync('dist', join(stage, 'dist'), { recursive: true });

// Зависимости заново — только когда поменялся package-lock.json
const lock = readFileSync('package-lock.json', 'utf8');
const stamp = join(stage, 'node_modules', '.win-lock');
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== lock) {
  run('npm', ['ci', '--os=win32', '--cpu=x64', '--ignore-scripts'], stage, { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' });
  writeFileSync(stamp, lock);
}
// Пересобирать нечего: sharp и onnxruntime приходят готовыми для Windows
run('npx', [...builder, '-c.npmRebuild=false'], stage);

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const setup = `canvaaaas-${version}-windows-x64-setup.exe`;
mkdirSync('release', { recursive: true });
copyFileSync(join(stage, 'release', setup), join('release', setup));
console.log(`Готово: release/${setup}`);

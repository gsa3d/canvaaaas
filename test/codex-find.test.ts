// Где canvaaaas находит Codex на Windows: раскладки npm, pnpm и установщика Codex собираются во временной папке,
// поиск идёт по правилам Windows (platform 'win32'), запускать ничего не нужно.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexBehindShim, findCodex, withCodexDirs } from '../src/providers/chatgpt-codex.ts';

// Обёртка, которую пишет npm (cmd-shim)
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;

// Обёртка pnpm: путь от %~dp0
const PNPM_SHIM = `@SETLOCAL
@IF NOT DEFINED NODE_PATH (
  @SET "NODE_PATH=%~dp0\\global\\5\\node_modules"
)
@IF EXIST "%~dp0\\node.exe" (
  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*
)
`;

const EXE = ['vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'];

let dir: string;
let env: NodeJS.ProcessEnv;

function file(path: string, text = ''): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** npm install -g @openai/codex в папку prefix: обёртка, пакет и пакет под платформу внутри него */
function npmInstall(prefix: string): string {
  file(join(prefix, 'codex.cmd'), NPM_SHIM);
  const pkg = join(prefix, 'node_modules', '@openai', 'codex');
  file(join(pkg, 'bin', 'codex.js'));
  return file(join(pkg, 'node_modules', '@openai', 'codex-win32-x64', ...EXE));
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'canvaaaas-codex-')));
  env = { PATH: '', CODEX_HOME: join(dir, '.codex'), LOCALAPPDATA: join(dir, 'Local'), APPDATA: join(dir, 'Roaming') };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Codex на Windows', () => {
  it('за обёрткой npm в PATH — codex.exe из пакета под платформу', () => {
    const exe = npmInstall(join(dir, 'nodejs'));
    env.Path = [join(dir, 'empty'), join(dir, 'nodejs')].join(delimiter);
    delete env.PATH;
    expect(findCodex(env, 'win32')).toBe(exe);
  });

  it('pnpm: пакет — ссылка в .pnpm, пакет под платформу лежит рядом', () => {
    const store = join(dir, 'pnpm', 'global', '5', '.pnpm', '@openai+codex@0.166.0', 'node_modules', '@openai');
    file(join(store, 'codex', 'bin', 'codex.js'));
    const exe = file(join(store, 'codex-win32-x64', ...EXE));
    mkdirSync(join(dir, 'pnpm', 'global', '5', 'node_modules', '@openai'), { recursive: true });
    symlinkSync(join(store, 'codex'), join(dir, 'pnpm', 'global', '5', 'node_modules', '@openai', 'codex'));
    const shim = file(join(dir, 'pnpm', 'codex.cmd'), PNPM_SHIM);
    expect(codexBehindShim(shim, 'x64')).toBe(exe);
  });

  it('старый пакет — exe в нём самом; arm64 — свой пакет, а нет его — x64', () => {
    const prefix = join(dir, 'old');
    file(join(prefix, 'codex.cmd'), NPM_SHIM);
    const pkg = join(prefix, 'node_modules', '@openai', 'codex');
    file(join(pkg, 'bin', 'codex.js'));
    const legacy = file(join(pkg, 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'));
    expect(codexBehindShim(join(prefix, 'codex.cmd'), 'arm64')).toBe(legacy);
    const arm = file(join(pkg, 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'));
    expect(codexBehindShim(join(prefix, 'codex.cmd'), 'arm64')).toBe(arm);
  });

  it('без PATH: свежая версия установщика, затем его папка в Programs, затем npm по умолчанию', () => {
    const npm = npmInstall(join(dir, 'Roaming', 'npm'));
    expect(findCodex(env, 'win32')).toBe(npm);
    const programs = file(join(dir, 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    expect(findCodex(env, 'win32')).toBe(programs);
    const releases = join(dir, '.codex', 'packages', 'standalone', 'releases');
    file(join(releases, '0.9.0', 'bin', 'codex.exe'));
    const fresh = file(join(releases, '0.10.1', 'bin', 'codex.exe'));
    expect(findCodex(env, 'win32')).toBe(fresh);
  });

  it('PATH главнее, CANVAAAAS_CODEX — ещё главнее, и обёртку в нём тоже разбирает', () => {
    file(join(dir, 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    const inPath = file(join(dir, 'bin', 'codex.exe'));
    env.PATH = join(dir, 'bin');
    expect(findCodex(env, 'win32')).toBe(inPath);
    const exe = npmInstall(join(dir, 'custom'));
    env.CANVAAAAS_CODEX = join(dir, 'custom', 'codex.cmd');
    expect(findCodex(env, 'win32')).toBe(exe);
  });

  it('нет Codex или exe за обёрткой — null, а не обёртка', () => {
    expect(findCodex(env, 'win32')).toBeNull();
    file(join(dir, 'npm', 'codex.cmd'), NPM_SHIM);
    file(join(dir, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    env.PATH = join(dir, 'npm');
    expect(findCodex(env, 'win32')).toBeNull();
  });

  it('при запуске папки Codex — в начале PATH, даже если ключ называется Path', () => {
    const root = join(dir, '.codex', 'packages', 'standalone', 'releases', '0.10.1');
    const exe = file(join(root, 'bin', 'codex.exe'));
    file(join(root, 'codex-resources', 'codex-windows-sandbox-setup.exe'));
    const res = withCodexDirs({ Path: 'C:\\Windows', HOME: 'x' }, exe, 'win32');
    expect(res).toEqual({ Path: [join(root, 'bin'), join(root, 'codex-resources'), 'C:\\Windows'].join(delimiter), HOME: 'x' });
    expect(withCodexDirs({ PATH: '/usr/bin' }, exe, 'darwin')).toEqual({ PATH: '/usr/bin' });
  });
});

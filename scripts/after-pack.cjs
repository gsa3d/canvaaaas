// electron-builder, afterPack: подписи разработчика Apple нет, поэтому пакет подписывается «на месте» (ad-hoc)
// до того, как ляжет в .dmg и .zip — иначе на Apple Silicon macOS считает его повреждённым.
// CommonJS: electron-builder загружает хуки через require.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};

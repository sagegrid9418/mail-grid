import fs from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { packager } from '@electron/packager';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
await execFile(process.execPath,[path.join(root,'scripts/build-locales.mjs')],{cwd:root});
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['macos', 'windows', 'linux'];
if (targets.some(target => !['macos', 'windows', 'linux'].includes(target))) throw new Error('Usage: node scripts/package-installers.mjs [macos windows linux]');
const output = path.join(root, 'out', 'installers');
await fs.mkdir(output, { recursive: true });
if(!JSON.parse(await fs.readFile(path.join(root,'assets/update-trust.json'),'utf8')).publicKeys?.length)throw Error('Run node scripts/release-key.mjs before building.');
const go = process.env.MAILGRID_GO || 'go';
const python = process.platform === 'win32' ? 'python' : 'python3';
const cache = process.env.MAILGRID_ELECTRON_CACHE || path.join(os.tmpdir(), 'mailgrid-electron-cache');
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
});
const hash = file => new Promise((resolve, reject) => { const value = crypto.createHash('sha256'); createReadStream(file).on('data', chunk => value.update(chunk)).on('error', reject).on('end', () => resolve(value.digest('hex'))); });
const nsisEscape = value => value.replaceAll('$', '$$').replaceAll('"', '$\\"');
async function inventory(dir, prefix = '') {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name); result.push({ relative, directory: entry.isDirectory() });
    if (entry.isDirectory()) result.push(...await inventory(path.join(dir, entry.name), relative));
  }
  return result;
}
async function verifyApplication(app) {
  const asar = require('@electron/asar'), archive = path.join(app,'resources/app.asar');
  if (!asar.extractFile(archive,'assets/update-trust.json').equals(readFileSync(path.join(root,'assets/update-trust.json')))) throw Error('Application verification keys are outdated.');
  if (JSON.parse(asar.extractFile(archive,'package.json')).version !== pkg.version) throw new Error('Application version does not match this installer.');
  for (const folder of ['dist-ui','dist-electron']) for (const entry of await inventory(path.join(root,folder))) {
    const relative=path.join(folder,entry.relative);
    if (!entry.directory && !asar.extractFile(archive,relative).equals(readFileSync(path.join(root,relative)))) throw new Error(`Application payload is outdated: ${relative}`);
  }
}
async function packageTarget(platform, temp) {
  const stage = path.join(temp, 'source'); await fs.mkdir(stage);
  for (const name of ['dist-ui', 'dist-electron', 'assets', 'README.md', 'VALIDATION.md']) await fs.cp(path.join(root, name), path.join(stage, name), { recursive: true });
  // Renderer dependencies are bundled; the desktop updater has production Node dependencies.
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, author: pkg.author, license: pkg.license, main: pkg.main, dependencies: pkg.dependencies }));
  const { stdout } = await execFile('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root });
  const copied = [];
  for (const directory of stdout.trim().split('\n').filter(item => item.startsWith(path.join(root, 'node_modules') + path.sep)).sort((a,b) => a.length - b.length)) {
    if (copied.some(parent => directory.startsWith(parent + path.sep))) continue;
    await fs.cp(directory, path.join(stage, path.relative(root, directory)), { recursive: true }); copied.push(directory);
  }
  const name = platform === 'win32' ? 'mailgrid-engine.exe' : 'mailgrid-engine';
  const engine = path.join(temp, name);
  await run(go, ['build', '-trimpath', '-o', engine, '.'], { cwd: path.join(root, 'engine'), env: { ...process.env, CGO_ENABLED: '0', GOOS: platform === 'win32' ? 'windows' : platform, GOARCH: 'amd64' } });
  const dirs = await packager({ dir: stage, out: path.join(temp, 'packaged'), name: 'Mail Grid', executableName: 'mail-grid', appBundleId: 'dev.mailgrid.app', platform, arch: 'x64', electronVersion: '45.0.0', icon: path.join(root, 'assets', 'icon'), asar: true, prune: false, overwrite: true, extraResource: [engine], download: { cacheRoot: cache } });
  const resources=path.join(dirs[0],'resources');
  await fs.writeFile(path.join(resources,'app-update.yml'),JSON.stringify({provider:'generic',url:'https://mail-dev.sagegrid.org',updaterCacheDirName:'MailGrid-updater',...(platform==='win32'?{verifyUpdateCodeSignature:false}:{})}));
  if(platform==='linux')await fs.writeFile(path.join(resources,'package-type'),'deb');
  return dirs[0];
}
async function makeMac() {
  if(process.platform!=='darwin')throw Error('Generate the universal DMG on macOS.');
  const space=await fs.statfs(root),required=5*1024**3;
  if(Number(space.bavail)*Number(space.bsize)<required)throw Error('Universal Mac packaging requires at least 5 GiB free. Free build space and rerun npm run installers -- macos. Existing installers are preserved.');
  await run(process.execPath,[path.join(root,'node_modules/electron-builder/cli.js'),'--config','electron-builder.cjs','--mac','dmg','--universal','--publish','never']);
  const folder=path.join(root,'out/releases',pkg.version),name=(await fs.readdir(folder)).find(name=>name.endsWith('.dmg'));
  if(!name)throw Error('The universal Mac build did not produce a DMG.');
  const file=path.join(output,`Mail-Grid-${pkg.version}-macOS-Universal.dmg`);await fs.copyFile(path.join(folder,name),file);return file;
}
async function makeWindows(temp) {
  const compiler = process.env.MAILGRID_MAKENSIS;
  if (!compiler) throw new Error('Set MAILGRID_MAKENSIS to the NSIS makensis compiler (see packaging/README.md).');
  const app = process.env.MAILGRID_WINDOWS_APP_DIR || await packageTarget('win32', temp), files = await inventory(app);
  await verifyApplication(app);
  const uninstall = path.join(temp, 'uninstall-files.nsh');
  const lines = files.filter(file => !file.directory).map(file => `Delete "$INSTDIR\\${nsisEscape(file.relative.split(path.sep).join('\\'))}"`);
  lines.push(...files.filter(file => file.directory).sort((a, b) => b.relative.length - a.relative.length).map(file => `RMDir "$INSTDIR\\${nsisEscape(file.relative.split(path.sep).join('\\'))}"`));
  await fs.writeFile(uninstall, lines.join('\n'));
  let bytes = 0; for (const file of files) if (!file.directory) bytes += (await fs.stat(path.join(app, file.relative))).size;
  const file = path.join(output, `Mail-Grid-${pkg.version}-Windows-x64-Setup.exe`);
  const temporary=path.join(temp,path.basename(file));
  await run(compiler, ['-V3', `-DAPP_DIRECTORY=${app}`, `-DAPP_ICON=${path.join(root, 'assets/icon.ico')}`, `-DAPP_VERSION=${pkg.version}`, `-DOUTPUT_FILE=${temporary}`, `-DUNINSTALL_INCLUDE=${uninstall}`, `-DINSTALLED_KB=${Math.ceil(bytes / 1024)}`, path.join(root, 'packaging/windows.nsi')], { env: { ...process.env, ...(process.platform === 'darwin' ? { LC_ALL: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8', LANG: 'en_US.UTF-8' } : {}) } });
  await fs.rename(temporary,file);
  return file;
}
async function makeLinux(temp) {
  const app = process.env.MAILGRID_LINUX_APP_DIR || await packageTarget('linux', temp);
  await verifyApplication(app);
  const file = path.join(output, `mail-grid_${pkg.version}_amd64.deb`);
  const temporary=path.join(temp,path.basename(file));
  await run(python, [path.join(root, 'scripts/make-deb.py'), '--app', app, '--icon', path.join(root, 'assets/icon.png'), '--version', pkg.version, '--output', temporary]);
  await fs.rename(temporary,file);
  return file;
}

const generated = [];
try {
  for (const target of targets) {
    console.log(`Building ${target} beta installer…`);
    const temp = await fs.mkdtemp(path.join(root, 'out', '.installer-'));
    try { generated.push(target === 'macos' ? await makeMac() : target === 'windows' ? await makeWindows(temp) : await makeLinux(temp)); }
    finally { if (!process.env.MAILGRID_KEEP_STAGING) await fs.rm(temp, { recursive: true, force: true }); }
    console.log(`Created ${generated.at(-1)}`);
  }
} finally {
  const names = (await fs.readdir(output)).filter(name => name.includes(pkg.version) && /\.(dmg|exe|deb|AppImage)$/.test(name)).sort();
  const sums = []; for (const name of names) sums.push(`${await hash(path.join(output, name))}  ${name}`);
  await fs.writeFile(path.join(output, 'SHA256SUMS'), sums.join('\n') + '\n');
  await fs.copyFile(path.join(root, 'packaging/INSTALL.txt'), path.join(output, 'INSTALL.txt'));
}

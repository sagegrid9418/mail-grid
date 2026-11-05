require('node:child_process').execFileSync(process.execPath,[require('node:path').join(__dirname,'scripts/build-locales.mjs')],{stdio:'inherit'});
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const production = false; // Paid platform signing is optional; free release trust is mandatory.
const trustDocument=fs.readFileSync(path.join(__dirname,'assets/update-trust.json'));
const helperTrust=trustDocument.toString('base64');
module.exports = {
  appId: 'dev.mailgrid.app', productName: 'Mail Grid', executableName: 'mail-grid',
  electronVersion: '45.0.0', asar: true,
  directories: { output: 'out/releases/${version}', buildResources: 'assets' },
  artifactName: 'Mail-Grid-${version}-${os}-${arch}.${ext}',
  files: ['dist-electron/**', 'dist-ui/**', 'assets/**', 'package.json', '!assets/*.pem'],
  extraResources: [{ from: 'engine/bin/release/${os}-${arch}', to: '.' }],
  forceCodeSigning: false,
  publish: null,
  afterPack: async context => {
    const resources = context.electronPlatformName === 'darwin' ? path.join(context.appOutDir, 'Mail Grid.app/Contents/Resources') : path.join(context.appOutDir, 'resources');
    fs.writeFileSync(path.join(resources, 'app-update.yml'), JSON.stringify({ provider: 'generic', url: 'https://mail-dev.sagegrid.org', updaterCacheDirName: 'MailGrid-updater', ...(context.electronPlatformName === 'win32' ? { verifyUpdateCodeSignature:false } : {}) }));
    if (context.electronPlatformName === 'linux') fs.writeFileSync(path.join(resources, 'package-type'), 'deb');
  },
  beforePack: async context => {
    const platform = context.electronPlatformName;
    const arch = require('builder-util').Arch[context.arch];
    const trust = JSON.parse(fs.readFileSync('assets/update-trust.json', 'utf8'));
    if (!trust.publicKeys?.length) throw new Error('Run node scripts/release-key.mjs before building installers. Free verification is required.');
    const output = path.resolve(`engine/bin/release/${context.packager.platform.name}-${arch}/${platform === 'win32' ? 'mailgrid-engine.exe' : 'mailgrid-engine'}`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    execFileSync(process.env.MAILGRID_GO || 'go', ['build', '-trimpath', '-o', output, '.'], { cwd: 'engine', stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', GOOS: platform === 'win32' ? 'windows' : platform, GOARCH: arch === 'x64' ? 'amd64' : arch } });
    if(platform==='darwin') execFileSync(process.env.MAILGRID_GO||'go',['build','-trimpath','-ldflags','-X main.trustBase64='+helperTrust,'-o',path.join(path.dirname(output),'mailgrid-updater'),'./cmd/mailgrid-updater'],{cwd:'engine',stdio:'inherit',env:{...process.env,CGO_ENABLED:'0',GOOS:'darwin',GOARCH:arch==='x64'?'amd64':arch}});
  },
  mac: { executableName: 'Mail Grid', target: [{target:'dmg',arch:['universal']}], category: 'public.app-category.developer-tools', identity: process.env.APPLE_SIGN_IDENTITY || '-', hardenedRuntime: !!process.env.APPLE_SIGN_IDENTITY, entitlements: 'assets/entitlements.mac.plist', entitlementsInherit: 'assets/entitlements.mac.plist', minimumSystemVersion: '13.0.0', notarize: false, extendInfo: { CFBundleDisplayName: 'Mail Grid', NSUserNotificationAlertStyle: 'banner' } },
  win: { target: ['nsis'], verifyUpdateCodeSignature:false, signtoolOptions: { signingHashAlgorithms: ['sha256'], ...(process.env.MAILGRID_WINDOWS_PUBLISHER ? { publisherName: process.env.MAILGRID_WINDOWS_PUBLISHER } : {}) } },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: false, deleteAppDataOnUninstall: false, createDesktopShortcut: 'always', include: 'packaging/update-migration.nsh', runAfterFinish: true },
  linux: { target: ['AppImage', 'deb'], category: 'Development', maintainer: 'Mail Grid', desktop: { entry: { Name: 'Mail Grid', StartupWMClass: 'Mail Grid' } } },
};

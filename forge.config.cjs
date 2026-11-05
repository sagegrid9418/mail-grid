const path = require('node:path');
const { platform } = process;
const engine = path.join(__dirname, 'engine', 'bin', platform === 'win32' ? 'mailgrid-engine.exe' : 'mailgrid-engine');

module.exports = {
  packagerConfig: {
    name: 'Mail Grid',
    executableName: 'mail-grid',
    appBundleId: 'dev.mailgrid.app',
    extendInfo: { CFBundleDisplayName: 'Mail Grid', NSUserNotificationAlertStyle: 'banner' },
    icon: path.join(__dirname, 'assets', 'icon'),
    extraResource: [engine],
    asar: true,
    ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
    ignore: [/^\/(?:engine|desktop|src|tests|scripts|website|\.release-private|\.github|\.agents|\.codex)(?:\/|$)/, /^\/out(?:\/|$)/, /\.pem$/, /^\/\.env(?:\.|$)/],
    ...(process.env.APPLE_SIGN_IDENTITY ? { osxSign: { identity: process.env.APPLE_SIGN_IDENTITY, optionsForFile: () => ({ entitlements: path.join(__dirname, 'assets', 'entitlements.mac.plist') }) } } : {}),
    ...(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID ? {
      osxNotarize: { appleId: process.env.APPLE_ID, appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD, teamId: process.env.APPLE_TEAM_ID },
    } : {}),
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { name: 'MailGrid', ...(process.env.WINDOWS_CERTIFICATE_FILE ? { certificateFile: process.env.WINDOWS_CERTIFICATE_FILE, certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD } : {}) } },
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: {} },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'], config: {} },
    { name: '@electron-forge/maker-deb', platforms: ['linux'], config: {} },
    { name: '@electron-forge/maker-rpm', platforms: ['linux'], config: {} },
  ],
};

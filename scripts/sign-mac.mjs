import path from 'node:path';
import { sign } from '@electron/osx-sign';

const version=JSON.parse(await (await import('node:fs/promises')).readFile('package.json')).version;
const app = path.resolve(process.argv[2] || `out/releases/${version}/mac-universal/Mail Grid.app`);
const identity = process.env.APPLE_SIGN_IDENTITY || '-';
if (process.platform !== 'darwin') throw new Error('Sign the Mac app on macOS.');
await sign({
  app, identity, platform: 'darwin', version: '45.0.0',
  type: process.env.MAILGRID_DEVELOPMENT_SIGN === '1' ? 'development' : 'distribution',
  preEmbedProvisioningProfile: false,
  optionsForFile: () => ({
    entitlements: path.resolve('assets/entitlements.mac.plist'), hardenedRuntime: identity !== '-',
    ...(process.env.MAILGRID_DEVELOPMENT_SIGN === '1' ? { timestamp: 'none' } : {}),
  }),
});
console.log('Verified code signature:', app);
console.log('Paid Developer ID signing and notarization are optional; free release signatures and checksums remain required.');

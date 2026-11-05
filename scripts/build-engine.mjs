import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const binDir = path.join(root, 'engine', 'bin');
mkdirSync(binDir, { recursive: true });
const output = path.join(binDir, process.platform === 'win32' ? 'mailgrid-engine.exe' : 'mailgrid-engine');
const result = spawnSync(process.env.MAILGRID_GO||'go', ['build', '-trimpath', '-o', output, '.'], {
  cwd: path.join(root, 'engine'),
  env: { ...process.env, CGO_ENABLED: '0', ...(process.env.MAILGRID_ARCH ? { GOARCH: process.env.MAILGRID_ARCH === 'x64' ? 'amd64' : process.env.MAILGRID_ARCH } : {}) },
  stdio: 'inherit',
});
if (result.error) {
  console.error('Go is required to build the mail engine:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);

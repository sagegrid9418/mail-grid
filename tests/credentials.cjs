const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailgrid-vault-'));
let available = true;
const safeStorage = {
  isAsyncEncryptionAvailable: async () => available,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptStringAsync: async (value) => Buffer.from('test-encrypted:' + Buffer.from(value).toString('base64')),
  decryptStringAsync: async (value) => ({ result: Buffer.from(value.toString().slice('test-encrypted:'.length), 'base64').toString(), shouldReEncrypt: false }),
};
function load() {
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../dist-electron/credentials.js'), 'utf8');
  new Function('require', 'module', 'exports', 'process', source)(
    (name) => name === 'electron' ? { app: { getPath: () => dir }, safeStorage } : require(name),
    module, module.exports, { ...process, argv: ['node', 'test'] },
  );
  return module.exports;
}
(async () => {
  try {
    let vault = load();
    await vault.rememberCredential(' ADMIN@example.test ', 'fixture-password');
    assert.equal((await vault.getCredential('admin@example.test')).password, 'fixture-password');
    const stored = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8');
    assert(!stored.includes('fixture-password'));
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777, 0o600);
    vault = load();
    assert.deepEqual(await vault.getCredential('admin@example.test'), { address: 'admin@example.test', password: 'fixture-password', persistent: true });
    await vault.rememberCredential('admin@example.test', 'new-password');
    vault = load();
    assert.equal((await vault.getCredential('admin@example.test')).password, 'new-password');
    available = false;
    await vault.rememberCredential('admin@example.test', 'session-only');
    assert.equal((await vault.getCredential('admin@example.test')).persistent, false);
    assert(!fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8').includes('session-only'));
    vault = load();
    assert.equal((await vault.getCredential('admin@example.test')).password, null);
    available = true;
    await vault.rememberCredential('admin@example.test', 'delete-me');
    vault.forgetCredential('admin@example.test');
    assert.equal((await vault.getCredential('admin@example.test')).password, null);
    assert(!fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8').includes('admin@example.test'));
    console.log('PASS: credential persistence, encryption-provider use, updates, session fallback, deletion');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

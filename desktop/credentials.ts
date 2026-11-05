import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const session = new Map<string, { password: string; persistent: boolean }>();
const file = () => path.join(app.getPath('userData'), 'credentials.json');
const normalize = (address: string) => address.trim().toLowerCase();
function readVault(): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function writeVault(value: Record<string, string>) {
  mkdirSync(path.dirname(file()), { recursive: true });
  writeFileSync(file() + '.tmp', JSON.stringify(value), { mode: 0o600 });
  renameSync(file() + '.tmp', file());
}
async function canPersist() {
  if (process.argv.includes('--test-mode')) return false;
  if (!await safeStorage.isAsyncEncryptionAvailable()) return false;
  return process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend());
}
export async function rememberCredential(address: string, password: string) {
  address = normalize(address);
  session.set(address, { password, persistent: false });
  // Remove the previous secret even if the current key store is unavailable.
  const previous = readVault();
  delete previous[address];
  try { writeVault(previous); } catch { /* Session copy remains available. */ }
  try {
    if (!await canPersist()) return;
    const encrypted = await safeStorage.encryptStringAsync(password);
    const vault = readVault();
    vault[address] = encrypted.toString('base64');
    writeVault(vault);
    session.set(address, { password, persistent: true });
  } catch { /* Never fall back to writing plaintext passwords. */ }
}
export async function getCredential(address: string) {
  address = normalize(address);
  const current = session.get(address);
  if (current) return { address, ...current };
  try {
    const encrypted = readVault()[address];
    if (encrypted && await canPersist()) {
      const { result: password, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'));
      session.set(address, { password, persistent: true });
      if (shouldReEncrypt) await rememberCredential(address, password);
      return { address, ...session.get(address)! };
    }
  } catch { /* An older account or locked key store needs the password entered again. */ }
  return { address, password: null, persistent: false };
}
export function forgetCredential(address: string) {
  address = normalize(address);
  session.delete(address);
  const vault = readVault();
  delete vault[address];
  writeVault(vault);
}

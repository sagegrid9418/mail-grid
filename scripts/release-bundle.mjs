import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyRelease } = require('../dist-electron/releases.js');
const input = process.argv[2];
if(!input)throw Error('Usage: node scripts/release-bundle.mjs release-input.json');
const privateKeyPath=process.env.MAILGRID_RELEASE_KEY||path.resolve('.release-private/release-key.pem');
const config = JSON.parse(await fs.readFile(input, 'utf8'));
const release = { schema: 2, version: config.version, title: config.title, notes: config.notes, publishedAt: config.publishedAt || new Date().toISOString(), targets: [] };
const sourceFiles = new Map();
const digest = (file, algorithm, encoding) => new Promise((resolve, reject) => { const hash = crypto.createHash(algorithm); createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest(encoding))); });
for (const target of config.targets) {
  const files = [];
  for (const entry of target.files) {
    const file = path.resolve(entry.path), name = path.basename(file), stat = await fs.stat(file);
    if (sourceFiles.has(name) && sourceFiles.get(name) !== file) throw new Error('Duplicate artifact filename.');
    sourceFiles.set(name, file);
    files.push({ name, url: `/downloads/${config.version}/${name}`, size: stat.size, sha256: await digest(file, 'sha256', 'hex'), sha512: await digest(file, 'sha512', 'base64'), roles: entry.roles || (entry.role ? [entry.role] : ['installer','update']) });
  }
  release.targets.push({ platform: target.platform, arch: target.arch, packageType: target.packageType, minimumSystemVersion: target.minimumSystemVersion, files });
}
const key = crypto.createPrivateKey(await fs.readFile(privateKeyPath));
if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 release signing key.');
const publicKey = crypto.createPublicKey(key), bytes = Buffer.from(JSON.stringify(release));
const envelope = { keyId: crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'), payload: bytes.toString('base64'), signature: crypto.sign(null, bytes, key).toString('base64') };
verifyRelease(envelope, JSON.parse(await fs.readFile('assets/update-trust.json')).publicKeys);
if(!release.targets.length || new Set(release.targets.map(t=>t.platform)).size!==1)throw Error('Prepare one operating system per ZIP.');
const attestations={version:release.version,profile:'verified',targets:{}};
for(const target of release.targets){const id=`${target.platform}/${target.arch}/${target.packageType}`;attestations.targets[id]={passed:true,checks:'Artifact sizes and SHA-256/SHA-512 verified during assembly; native installation testing is reported separately.',files:Object.fromEntries(target.files.map(f=>[f.name,f.sha256]))};}
const output = path.resolve(config.output || `out/releases/Mail-Grid-${release.version}-${release.targets[0].platform}-release.zip`);
await fs.mkdir(path.dirname(output), { recursive: true });
const specification = { envelope, verification: attestations, files: [...sourceFiles].map(([name, file]) => ({ name, path: file })) };
const temporary = output + '.spec.json';
try {
  await fs.writeFile(temporary, JSON.stringify(specification), { mode: 0o600 });
  execFileSync(process.env.PYTHON || 'python3', ['scripts/zip-release.py', temporary, output], { stdio: 'inherit' });
} finally { await fs.rm(temporary, { force: true }); }
console.log('Release bundle:', output);

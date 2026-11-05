import { createHash, createPublicKey, verify } from 'node:crypto';
import semver from 'semver';

export const RELEASE_ORIGIN = 'https://mail-dev.sagegrid.org';
export type UpdateMode = 'manual' | 'automatic';
export type UpdatePreference = UpdateMode;
export type ReleaseFile = { name: string; url: string; size: number; sha256: string; sha512: string; role?: 'installer' | 'update' | 'blockmap'; roles?: ('installer' | 'update' | 'blockmap')[] };
export type ReleaseTarget = { platform: 'darwin' | 'win32' | 'linux'; arch: 'x64' | 'arm64' | 'universal'; packageType: 'mac' | 'nsis' | 'appimage' | 'deb'; minimumSystemVersion: string; files: ReleaseFile[] };
export type Release = { schema: 1 | 2; version: string; title: string; notes: string; publishedAt: string; targets: ReleaseTarget[] };
export type ReleaseEnvelope = { keyId: string; payload: string; signature: string };
export type ReleaseResult = { release: Release | null; target: ReleaseTarget | null };
export const hasRole = (file: ReleaseFile, role: 'installer' | 'update' | 'blockmap') => file.role === role || file.roles?.includes(role) === true;
export const targetID = (target: Pick<ReleaseTarget,'platform'|'arch'|'packageType'>) => `${target.platform}/${target.arch}/${target.packageType}`;
export const TARGETS = ['darwin/x64/mac','darwin/arm64/mac','darwin/universal/mac','win32/x64/nsis','linux/x64/appimage','linux/x64/deb'];
export function verifyRelease(envelope: ReleaseEnvelope, publicKeys: string[], origin = RELEASE_ORIGIN): Release {
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 700000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) || typeof envelope.signature !== 'string') throw new Error('Invalid release envelope.');
  const bytes = Buffer.from(envelope.payload, 'base64');
  const trusted = publicKeys.some(pem => {
    try {
      const key = createPublicKey(pem);
      return key.asymmetricKeyType === 'ed25519' && createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex') === envelope.keyId && verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'));
    } catch { return false; }
  });
  if (!trusted) throw new Error('The release signature could not be verified. Nothing was downloaded.');
  const release = JSON.parse(bytes.toString('utf8')) as Release;
  if (![1,2].includes(release.schema) || !semver.valid(release.version) || semver.prerelease(release.version) || typeof release.title !== 'string' || release.title.length > 200 || typeof release.notes !== 'string' || release.notes.length > 32000 || !Number.isFinite(Date.parse(release.publishedAt)) || !Array.isArray(release.targets) || release.targets.length < 1 || release.targets.length > 8) throw new Error('Invalid release information.');
  const seen = new Set<string>(), names = new Map<string,string>();
  for (const target of release.targets) {
    const id = targetID(target);
    if (seen.has(id) || !TARGETS.includes(id) || (release.schema === 1 && target.arch === 'universal') || !semver.valid(target.minimumSystemVersion) || !Array.isArray(target.files) || target.files.length < 1 || target.files.length > 8) throw new Error('Invalid release target.');
    seen.add(id);
    const filenames = new Set<string>();
    for (const file of target.files) {
      const url = new URL(file.url, origin), roles = release.schema === 1 ? [file.role] : file.roles;
      if (typeof file.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(file.name) || filenames.has(file.name) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 2147483648 || !/^[a-f0-9]{64}$/.test(file.sha256) || Buffer.from(file.sha512, 'base64').length !== 64 || !Array.isArray(roles) || !roles.length || new Set(roles).size !== roles.length || roles.some(role => !['installer','update','blockmap'].includes(role || '')) || url.origin !== new URL(origin).origin || url.username || url.password || url.hash || url.search || url.pathname !== `/downloads/${release.version}/${file.name}`) throw new Error('Invalid release artifact.');
      const description=JSON.stringify(file); if(names.has(file.name) && names.get(file.name)!==description) throw new Error('Conflicting artifact names.');
      names.set(file.name,description);filenames.add(file.name);
    }
    const extension = target.packageType === 'mac' ? release.schema === 2 ? '.dmg' : '.zip' : target.packageType === 'nsis' ? '.exe' : target.packageType === 'deb' ? '.deb' : '.AppImage';
    if (!target.files.some(file => hasRole(file,'update') && file.name.endsWith(extension))) throw new Error('The release has no compatible updater artifact.');
  }
  return release;
}
export class ReleaseSource {
  current: ReleaseResult = { release: null, target: null };
  envelope: ReleaseEnvelope | null = null;
  constructor(readonly options: { origin: string; keys: string[]; platform: string; arch: string; packageType: string; systemVersion: string; fetch?: typeof fetch }) {}
  async latest(signal?:AbortSignal): Promise<ReleaseResult> {
    if (!this.options.keys.length) throw new Error('Update service is not configured for this installation. Install the latest Mail Grid installer.');
    const query = new URLSearchParams({platform:this.options.platform,arch:this.options.arch,packageType:this.options.packageType,systemVersion:semver.coerce(this.options.systemVersion)?.version||'0.0.0'});
    const request=async(url:string)=>{try{return await (this.options.fetch||fetch)(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),redirect:'error',headers:{Accept:'application/json'}})}catch{throw new Error('Could not reach the update service. Check your connection and try again.')}};
    let response=await request(`${this.options.origin}/api/v2/releases/latest?${query}`);
    if(response.status===404)response=await request(`${this.options.origin}/api/v1/releases/latest`);
    if (!response.ok) throw new Error(`The release server returned ${response.status}. Try again later.`);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty release response.');
    let size=0;const chunks:Uint8Array[]=[];
    try { while(true) { const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>1048576)throw new Error('Release response is too large.');chunks.push(item.value); } } finally { await reader.cancel(); }
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const release=body.release===null?null:verifyRelease(body.release,this.options.keys,this.options.origin);
    const compatible=release?.targets.filter(item=>item.platform===this.options.platform && item.packageType===this.options.packageType && (item.arch===this.options.arch || item.platform==='darwin' && item.arch==='universal')) || [];
    const target=compatible.find(item=>item.arch==='universal') || compatible[0] || null;
    if(target && semver.lt(semver.coerce(this.options.systemVersion)||'0.0.0',target.minimumSystemVersion))throw new Error('This update requires a newer operating system. Your current version will keep working.');
    this.envelope=release?body.release:null;this.current={release,target};return this.current;
  }
}

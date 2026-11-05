const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {verifyRelease,RELEASE_ORIGIN}=require('../dist-electron/releases');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version,keys=require('../assets/update-trust.json').publicKeys;
for(const [name,id]of [['macos','darwin/universal/mac'],['windows','win32/x64/nsis'],['linux-deb','linux/x64/deb']]){
 const file=path.join(root,`out/releases/Mail-Grid-${version}-${name}-release.zip`);
 const metadata=JSON.parse(execFileSync('python3',['-c',`import sys,zipfile,json,hashlib
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert all(n in ['release.json','verification.json'] or n.startswith('artifacts/') and '/' not in n[10:] for n in z.namelist())
 assert not any(n.endswith('.pem') or '.env' in n or 'private' in n for n in z.namelist())
 envelope=json.loads(z.read('release.json'));verification=json.loads(z.read('verification.json'));hashes={}
 for n in z.namelist():
  if n.startswith('artifacts/'):
   h=hashlib.sha256()
   with z.open(n) as stream:
    for data in iter(lambda:stream.read(1024*1024),b''):h.update(data)
   hashes[n[10:]]=h.hexdigest()
 print(json.dumps(dict(envelope=envelope,verification=verification,hashes=hashes)))`,file],{maxBuffer:2*1024*1024}));
 const release=verifyRelease(metadata.envelope,keys,RELEASE_ORIGIN);assert.equal(release.version,version);assert.equal(release.schema,2);assert.equal(release.targets.length,1);assert.equal(`${release.targets[0].platform}/${release.targets[0].arch}/${release.targets[0].packageType}`,id);assert.equal(metadata.verification.profile,'verified');
 for(const artifact of release.targets[0].files){assert.equal(metadata.hashes[artifact.name],artifact.sha256);assert.equal(metadata.verification.targets[id].files[artifact.name],artifact.sha256);const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'out/installers',artifact.name))).digest('hex');assert.equal(actual,artifact.sha256,'Release bundle contains a stale installer')}
 console.log('PASS: '+name+' upload ZIP integrity, real Ed25519 signature, single compatible target, current installer checksum, free artifact verification and no private data');
}

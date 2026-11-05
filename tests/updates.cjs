const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { verifyRelease, ReleaseSource } = require('../dist-electron/releases');
const { Updates } = require('../dist-electron/updates');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const key = publicKey.export({type:'spki',format:'pem'});
const data = Buffer.from('a harmless fixture');
const file = {name:'Mail-Grid-0.9.0.exe',url:'/downloads/0.9.0/Mail-Grid-0.9.0.exe',size:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex'),sha512:crypto.createHash('sha512').update(data).digest('base64'),role:'update'};
const release = {schema:1,version:'0.9.0',title:'A local test release',notes:'<script>not executable</script>\nReal release notes',publishedAt:new Date().toISOString(),targets:[{platform:'win32',arch:'x64',packageType:'nsis',minimumSystemVersion:'10.0.0',files:[file]}]};
function envelope(value, signingKey=privateKey) { const bytes=Buffer.from(JSON.stringify(value)); return {keyId:crypto.createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex'),payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,signingKey).toString('base64')}; }
class Adapter extends EventEmitter {
  downloads=0; installs=0; cancellations=0;
  constructor(source){super();this.source=source;}
  async checkForUpdates(){await this.source.latest();}
  async downloadUpdate(){this.downloads++;this.emit('download-progress',{percent:60});}
  quitAndInstall(){this.installs++;}
  cancelDownload(){this.cancellations++;}
}
(async()=>{
 let legacyOnly=false;const requests=[];let body={release:envelope(release),policy:{defaultMode:'manual'}};
 const server=http.createServer((req,res)=>{requests.push(req.url);assert(!req.headers['x-user-staging-id']);if(legacyOnly&&req.url.startsWith('/api/v2/')){res.writeHead(404);res.end();return}res.setHeader('content-type','application/json');res.end(JSON.stringify(body));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=`http://127.0.0.1:${server.address().port}`;
 try {
  assert.equal(verifyRelease(body.release,[key],origin).version,'0.9.0');
  assert.throws(()=>verifyRelease({...body.release,payload:Buffer.from(JSON.stringify({...release,version:'1.0.0'})).toString('base64')},[key],origin),/signature/);
  assert.throws(()=>verifyRelease(envelope({...release,targets:[{...release.targets[0],files:[{...file,url:'https://attacker.invalid/a.exe'}]}]}),[key],origin),/artifact/);
  assert.throws(()=>verifyRelease(body.release,[],origin),/signature/);
  const source=new ReleaseSource({origin,keys:[key],platform:'win32',arch:'x64',packageType:'nsis',systemVersion:'10.0.22631'});
  const adapter=new Adapter(source); const prefs=[];const states=[];let stopped=0,recovered=0;
  const updates=new Updates({version:'0.2.0',source,adapter,supported:true,preferences:{},persist:value=>prefs.push(value),emit:state=>states.push(state),stopEngine:async()=>{stopped++},recoverEngine:async()=>{recovered++}});
  assert.equal(adapter.autoDownload,false);assert.equal(adapter.autoInstallOnAppQuit,false);assert.equal(adapter.allowDowngrade,false);
  await updates.check();assert.equal(updates.state.phase,'available');assert.equal(adapter.downloads,0);
  body.policy.defaultMode='automatic'; updates.preferences({preference:'manual',automaticChecks:true});
  await updates.check();assert.equal(adapter.downloads,0);assert.equal(updates.state.effectiveMode,'manual');
  assert.throws(()=>updates.preferences({preference:'inherit',automaticChecks:true}),/Invalid update preferences/);
  await updates.check();assert.equal(adapter.downloads,0);
  const migratedPrefs=[];const legacy=new Updates({version:'0.2.0',source,adapter:new Adapter(source),supported:true,preferences:{preference:'inherit',automaticChecks:false},persist:value=>migratedPrefs.push(value),emit:()=>{},stopEngine:async()=>{},recoverEngine:async()=>{}});
  assert.equal(legacy.state.preference,'manual');assert.equal(legacy.state.automaticChecks,false);assert.deepEqual(migratedPrefs,[{preference:'manual',automaticChecks:false}]);await legacy.check();assert.equal(legacy.state.phase,'available');
  delete body.policy;await updates.check();assert.equal(adapter.downloads,0);
  body.policy={defaultMode:'manual'};updates.preferences({preference:'automatic',automaticChecks:true});await updates.check();assert.equal(adapter.downloads,1);assert.equal(updates.state.phase,'ready');assert.equal(stopped,0);assert.equal(adapter.installs,0);
  body.release=null;await updates.install();assert.equal(adapter.installs,0);assert.equal(stopped,0);assert.equal(updates.state.phase,'error');
  body.release=envelope(release);await updates.check();assert.equal(updates.state.phase,'ready');await Promise.all([updates.install(),updates.install()]);assert.equal(stopped,1);assert.equal(adapter.installs,1);
  const wrongOS=new ReleaseSource({...source.options,systemVersion:'6.1.0'});await assert.rejects(()=>wrongOS.latest(),/newer operating/);
  const unsupported=new ReleaseSource({...source.options,arch:'arm64'});assert.equal((await unsupported.latest()).target,null);
  body.release=envelope({...release,version:'0.1.0',targets:release.targets.map(t=>({...t,files:t.files.map(f=>({...f,name:f.name.replace('0.9.0','0.1.0'),url:f.url.replaceAll('0.9.0','0.1.0')}))}))});
  const old=new Updates({version:'0.2.0',source,adapter:new Adapter(source),supported:true,preferences:{},persist:()=>{},emit:()=>{},stopEngine:async()=>{},recoverEngine:async()=>{}});await old.check();assert.equal(old.state.phase,'idle');
  body.release=envelope(release); body.policy.defaultMode='manual';
  const failed=new Updates({version:'0.2.0',source,adapter:new Adapter(source),supported:true,preferences:{},persist:()=>{},emit:()=>{},stopEngine:async()=>{throw Error('shutdown refused')},recoverEngine:async()=>{recovered++}});
  await failed.check();await failed.download();await failed.install();assert.equal(failed.state.phase,'ready');assert.equal(failed.state.error,'shutdown refused');assert.equal(recovered,1);
  const cancelAdapter=new Adapter(source);let began,finish;const started=new Promise(resolve=>{began=resolve});
  cancelAdapter.downloadUpdate=async()=>{began();await new Promise(resolve=>{finish=resolve})};
  const cancelled=new Updates({version:'0.2.0',source,adapter:cancelAdapter,supported:true,preferences:{},persist:()=>{},emit:()=>{},stopEngine:async()=>{throw Error('should not stop')},recoverEngine:async()=>{}});
  await cancelled.check();const downloading=cancelled.download();await started;cancelled.cancel();finish();await downloading;assert.equal(cancelled.state.phase,'available');assert.equal(cancelAdapter.cancellations,1);
  const dmg={...file,name:'Mail-Grid-0.9.0-universal.dmg',url:'/downloads/0.9.0/Mail-Grid-0.9.0-universal.dmg',role:undefined,roles:['installer','update']};
  const universal={...release,schema:2,targets:[{platform:'darwin',arch:'universal',packageType:'mac',minimumSystemVersion:'13.0.0',files:[dmg]}]};
  body.release=envelope(universal);assert.equal(verifyRelease(body.release,[key],origin).schema,2);
  for(const arch of ['x64','arm64']){const mac=new ReleaseSource({...source.options,platform:'darwin',arch,packageType:'mac',systemVersion:'13.7.8'});assert.equal((await mac.latest()).target.arch,'universal')}
  assert.throws(()=>verifyRelease(envelope({...universal,schema:1}),[key],origin),/target/);
  assert.throws(()=>verifyRelease(envelope({...universal,targets:[{...universal.targets[0],files:[{...dmg,roles:['installer','update','update']}]}]}),[key],origin),/artifact/);
  const deb={...dmg,name:'Mail-Grid-0.9.0.deb',url:'/downloads/0.9.0/Mail-Grid-0.9.0.deb'};body.release=envelope({...universal,targets:[{platform:'linux',arch:'x64',packageType:'deb',minimumSystemVersion:'5.4.0',files:[deb]}]});
  const linux=new ReleaseSource({...source.options,platform:'linux',packageType:'deb',systemVersion:'6.8.0-52-generic'});assert.equal((await linux.latest()).target.packageType,'deb');assert(requests.at(-1).includes('systemVersion=6.8.0'));
  body.release=envelope(release);legacyOnly=true;await source.latest();assert(requests.at(-1).startsWith('/api/v1/releases/latest'));legacyOnly=false;
  const prepareAdapter=new Adapter(source);prepareAdapter.prepareInstall=async()=>{throw Error('not enough space')};let prepareStops=0;
  const prepare=new Updates({version:'0.2.0',source,adapter:prepareAdapter,supported:true,preferences:{},persist:()=>{},emit:()=>{},stopEngine:async()=>{prepareStops++},recoverEngine:async()=>{}});await prepare.check();await prepare.download();await prepare.install();assert.equal(prepare.state.phase,'ready');assert.equal(prepareStops,0);assert.equal(prepareAdapter.installs,0);assert.equal(prepare.state.error,'not enough space');
  await new Promise(resolve=>server.close(resolve));await old.check(false);assert.equal(old.state.phase,'idle');await old.check();assert.equal(old.state.phase,'error');
  console.log('PASS: signed loopback feed, tamper rejection, legacy/v2 feeds, universal Mac architectures, Linux kernel normalization, preparation failure before shutdown, OS/architecture/version gates, user-only manual/automatic preferences, legacy preference migration, ignored publisher policy, progress, withdrawal, approved installation, safe-shutdown failure, offline behavior');
 } finally {server.closeAllConnections();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1});

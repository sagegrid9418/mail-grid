// Native, isolated macOS helper rehearsal. Uses harmless mock applications;
// never registers them with LaunchServices or touches the installed Mail Grid.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),go=process.env.MAILGRID_GO||'go';
const run=(exe,args,options={})=>execFileSync(exe,args,{stdio:'pipe',...options});
const wait=async(fn,timeout=120000)=>{const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,200))}throw Error('Native update rehearsal timed out')};
(async()=>{
 if(process.platform!=='darwin')throw Error('This test requires macOS.');
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mailgrid-native-update-'))),children=[];let mockPids=[];
 try{
  const keys=crypto.generateKeyPairSync('ed25519'),pem=keys.publicKey.export({type:'spki',format:'pem'}),trust=Buffer.from(JSON.stringify({publicKeys:[pem]})).toString('base64');
  const helper=path.join(temp,'helper');run(go,['build','-trimpath','-ldflags','-X main.trustBase64='+trust,'-o',helper,'./cmd/mailgrid-updater'],{cwd:path.join(root,'engine')});
  const source=path.join(temp,'mock.go');fs.writeFileSync(source,`package main
import("encoding/json";"os";"path/filepath";"time")
var version="0.2.1"
var healthy="yes"
func main(){
 profile:=os.Getenv("MAILGRID_DATA_DIR");var token,work string
 for i,a:=range os.Args {if a=="--mailgrid-update-token"&&i+1<len(os.Args){token=os.Args[i+1]};if a=="--mailgrid-update-work"&&i+1<len(os.Args){work=os.Args[i+1]}}
 b,_:=json.Marshal(map[string]any{"pid":os.Getpid(),"version":version,"token":token})
 if profile!="" {os.WriteFile(filepath.Join(profile,"mock-launch.json"),b,0600)}
 if token!=""&&healthy=="yes" {os.WriteFile(filepath.Join(work,"health.json"),b,0600)}
 if token!=""&&healthy=="no" {return};time.Sleep(10*time.Minute)
}`);
  const binary=async(version,healthy)=>{const outputs=[];for(const arch of ['amd64','arm64']){const file=path.join(temp,version+'-'+healthy+'-'+arch);run(go,['build','-trimpath','-ldflags',`-X main.version=${version} -X main.healthy=${healthy}`,'-o',file,source],{env:{...process.env,GOOS:'darwin',GOARCH:arch,CGO_ENABLED:'0'}});outputs.push(file)}const file=path.join(temp,version+'-'+healthy+'-universal');run('/usr/bin/lipo',['-create',...outputs,'-output',file]);return file};
  const old=await binary('0.2.1','yes'),good=await binary('0.3.0','yes'),bad=await binary('0.3.0','no');
  function makeApp(parent,version,binary){const app=path.join(parent,'Mail Grid.app');fs.mkdirSync(path.join(app,'Contents/MacOS'),{recursive:true});fs.mkdirSync(path.join(app,'Contents/Resources'),{recursive:true});fs.writeFileSync(path.join(app,'Contents/Info.plist'),JSON.stringify({CFBundleIdentifier:'dev.mailgrid.app',CFBundleName:'Mail Grid',CFBundleExecutable:'Mail Grid',CFBundleShortVersionString:version,CFBundleVersion:version,CFBundlePackageType:'APPL'}));run('/usr/bin/plutil',['-convert','xml1',path.join(app,'Contents/Info.plist')]);for(const name of ['Contents/MacOS/Mail Grid','Contents/Resources/mailgrid-engine','Contents/Resources/mailgrid-updater']){fs.copyFileSync(binary,path.join(app,name));fs.chmodSync(path.join(app,name),0o755)}run('/usr/bin/codesign',['--force','--deep','--sign','-',app]);return app}
  async function scenario(name,binary,succeeds){
   const base=path.join(temp,name);fs.mkdirSync(base);const app=makeApp(base,'0.2.1',old),profile=path.join(base,'profile');fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'mailbox-sentinel'),'Existing fictional mail must survive');
   const work=path.join(profile,'updates/install-rehearsal');fs.mkdirSync(work,{recursive:true,mode:0o700});const image=path.join(work,'update.dmg'),src=path.join(base,'image-source');fs.mkdirSync(src);makeApp(src,'0.3.0',binary);
   run('/usr/bin/hdiutil',['create','-quiet','-srcfolder',src,'-volname','Mail Grid isolated test','-format','UDZO',image]);
   const bytes=fs.readFileSync(image),file={name:'update.dmg',url:'/downloads/0.3.0/update.dmg',size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),sha512:crypto.createHash('sha512').update(bytes).digest('base64'),roles:['installer','update']};
   const release={schema:2,version:'0.3.0',title:'Isolated mock native rehearsal',notes:'Not a distributable installer',publishedAt:new Date().toISOString(),targets:[{platform:'darwin',arch:'universal',packageType:'mac',minimumSystemVersion:'13.0.0',files:[file]}]},payload=Buffer.from(JSON.stringify(release)),envelope={keyId:crypto.createHash('sha256').update(keys.publicKey.export({type:'spki',format:'der'})).digest('hex'),payload:payload.toString('base64'),signature:crypto.sign(null,payload,keys.privateKey).toString('base64')};
   const parent=spawn('/bin/sleep',['3']);children.push(parent);const plan={app,profile,testMode:true,artifact:image,token:crypto.randomBytes(32).toString('hex'),parent:parent.pid,envelope,phase:'prepared'},planFile=path.join(work,'plan.json'),localHelper=path.join(work,'mailgrid-updater');fs.copyFileSync(helper,localHelper);fs.chmodSync(localHelper,0o700);fs.writeFileSync(planFile,JSON.stringify(plan),{mode:0o600});
   run(localHelper,['--check',planFile]); // Rehearse mount, signature, universal binaries and free-space checks while parent lives.
   const child=spawn(localHelper,['--run',planFile],{stdio:['ignore','pipe','pipe']});children.push(child);let stderr='';child.stderr.on('data',v=>stderr+=v);child.stdout.on('data',()=>{});const exit=new Promise(resolve=>child.once('exit',resolve));
   const code=await Promise.race([exit,new Promise((_,reject)=>{const timeout=setTimeout(()=>reject(Error('Native helper timed out: '+stderr)),120000);timeout.unref()})]);
   const launch=await wait(()=>{try{const value=JSON.parse(fs.readFileSync(path.join(profile,'mock-launch.json')));return value.version===(succeeds?'0.3.0':'0.2.1')?value:null}catch{return null}},10000);mockPids.push(launch.pid);
   assert.equal(fs.readFileSync(path.join(profile,'mailbox-sentinel'),'utf8'),'Existing fictional mail must survive');
   const info=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')]));assert.equal(info.CFBundleShortVersionString,succeeds?'0.3.0':'0.2.1');
   if(succeeds){assert.equal(code,0,stderr);assert(!fs.existsSync(work),'Successful commit cleans private cache');assert.equal(launch.version,'0.3.0')}
   else{assert.notEqual(code,0);assert.equal(JSON.parse(fs.readFileSync(planFile)).phase,'rolled-back');assert.equal(launch.version,'0.2.1')}
   assert(!fs.readdirSync(base).some(n=>n.startsWith('.MailGrid-backup-')));try{process.kill(launch.pid,'SIGTERM')}catch{}
   console.log('PASS: native detached '+name+' with real signed DMG, universal mock app, protected profile, and '+(succeeds?'startup commit':'failed-startup rollback and old-app relaunch'));
  }
  await scenario('replacement',good,true);await scenario('startup-failure',bad,false);
 }finally{for(const child of children)if(child.exitCode===null)child.kill();for(const pid of mockPids)try{process.kill(pid,'SIGTERM')}catch{}fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});

// Execute the final universal payload on this Intel Mac without installing it,
// accessing the user's profile, registering startup, or requesting notifications.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{_electron:electron}=require('playwright');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const appPath=path.resolve(process.argv[2]||path.join(root,`out/releases/${version}/mac-universal/Mail Grid.app`));
const free=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port))})});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mailgrid-packaged-mac-'));let app;
 try{
  for(const binary of ['Contents/MacOS/Mail Grid','Contents/Resources/mailgrid-engine','Contents/Resources/mailgrid-updater']){const architectures=execFileSync('/usr/bin/lipo',['-archs',path.join(appPath,binary)],{encoding:'utf8'});assert(architectures.includes('arm64')&&architectures.includes('x86_64'),binary)}
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',appPath]);
  const env={...process.env,MAILGRID_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:path.join(appPath,'Contents/MacOS/Mail Grid'),args:['--test-mode'],env});const page=await app.firstWindow();page.setDefaultTimeout(30000);
  await page.getByRole('button',{name:'Finish setup',exact:true}).waitFor();assert.equal((await page.evaluate(()=>window.mailgrid.request('status'))).running,false);
  const ports={smtp:await free(),imap:await free(),pop3:await free()};fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({ports,startAtLogin:false,notificationsEnabled:false}));await page.getByRole('checkbox').uncheck();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.getByText('Mail service running',{exact:true}).waitFor();
  assert.equal(await app.evaluate(({app})=>app.getVersion()),version);assert.equal((await page.evaluate(()=>window.mailgrid.request('updates.get'))).phase,'idle','Installed build must have a configured updater/public key');
  const code=`import smtplib,sys\nfrom email.message import EmailMessage\nm=EmailMessage();m['From']='Fictional Sender <app@example.test>';m['To']='unknown@example.test';m['Subject']='Packaged HTML — 日本語';m.set_content('<html><head><style>h1{color:rgb(124,58,237)}</style></head><body dir="rtl" style="background-color:rgb(240,241,242)"><h1>Real HTML preview</h1><script>window.__unsafe=true</script><img src="https://invalid.example/tracker"></body></html>',subtype='html')\nwith smtplib.SMTP('127.0.0.1',int(sys.argv[1])) as s:s.send_message(m)\n`;
  execFileSync('python3',['-c',code,String(ports.smtp)]);await page.getByRole('button',{name:/Packaged HTML — 日本語/}).click();
  const frame=page.frameLocator('iframe[title="Safe email preview"]');await frame.getByRole('heading',{name:'Real HTML preview'}).waitFor();assert.equal(await frame.getByRole('heading').evaluate(e=>getComputedStyle(e).color),'rgb(124, 58, 237)');assert.equal(await frame.locator('body').getAttribute('dir'),'rtl');assert.equal(await frame.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(240, 241, 242)');const source=await page.locator('iframe').getAttribute('srcdoc');assert(!source.includes('<script>')&&!source.includes('src="https://'));
  await page.screenshot({path:path.join(root,`test-results/packaged-${version}-mac-intel.png`)});console.log('PASS: final universal app executes on Intel macOS, valid local signature, required fresh setup, isolated live SMTP HTML-only message with Unicode subject/body styles/direction, blocked active/remote content, and configured verified updater. No installation or system registration performed.');
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});

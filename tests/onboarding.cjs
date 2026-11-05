const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {_electron:electron}=require('playwright'),root=path.resolve(__dirname,'..');
const free=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mailgrid-onboarding-'));let app;
 const launch=async()=>{const env={...process.env,MAILGRID_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({args:[root,'--preview','--test-mode'],env});const page=await app.firstWindow();page.setDefaultTimeout(20000);return page};
 try{
  let page=await launch();await page.getByRole('button',{name:'Finish setup',exact:true}).waitFor();
  assert.equal(await page.locator('.app-shell').count(),0);assert.equal((await page.evaluate(()=>window.mailgrid.request('status'))).running,false);
  await assert.rejects(()=>page.evaluate(()=>window.mailgrid.restart()));await assert.rejects(()=>page.evaluate(()=>window.mailgrid.testNotification()));assert(!fs.existsSync(path.join(dir,'mail.db')));assert.equal(await page.getByRole('button',{name:/skip|dismiss|close/i}).count(),0);
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Finish setup',exact:true}).count(),1);
  await page.getByLabel('Interface language',{exact:true}).selectOption('ar');await page.getByRole('button',{name:'إنهاء الإعداد',exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
  await page.locator('.setup-preferences>label select').first().selectOption('dark');
  await page.locator('.setup-preferences>label select').nth(1).selectOption('automatic');
  await page.getByRole('checkbox').uncheck();await page.waitForFunction(async()=>!(await window.mailgrid.request('onboarding.get')).choices.automaticChecks);await app.close();app=null;
  page=await launch();await page.getByRole('button',{name:'إنهاء الإعداد',exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');assert.equal(await page.getByRole('checkbox').isChecked(),false);
  assert.equal(await page.locator('.setup-preferences>label select').nth(1).inputValue(),'automatic');
  await page.locator('.language-picker select').selectOption('ja');await page.getByRole('button',{name:'設定を完了',exact:true}).waitFor();
  assert.equal(await page.locator('html').getAttribute('dir'),'ltr');await page.locator('.language-picker select').selectOption('en');
  const ports={smtp:await free(),imap:await free(),pop3:await free()};
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({ports,startAtLogin:false,notificationsEnabled:false,retentionDays:0}));
  await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.getByText('Mail service running',{exact:true}).waitFor();
  const prefs=JSON.parse(fs.readFileSync(path.join(dir,'desktop-preferences.json')));assert(prefs.onboarding.completed);assert.equal(prefs.updates.preference,'automatic');assert.equal(prefs.updates.automaticChecks,false);
  await app.close();app=null;page=await launch();await page.getByText('Mail service running',{exact:true}).waitFor();assert.equal(await page.locator('.first-launch').count(),0);assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await assert.rejects(()=>page.evaluate(()=>window.mailgrid.request('language.set',{language:'../../private'})));
  console.log('PASS: required fresh-profile setup, no mail listeners/database before completion, Escape protection, RTL/CJK language changes, persisted unfinished choices, independent automatic-check preference, completion and restart persistence');
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});

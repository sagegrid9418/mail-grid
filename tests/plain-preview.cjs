const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {_electron:electron}=require('playwright'),root=path.resolve(__dirname,'..');
const free=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port))})});
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mailgrid-plain-preview-'));let app;
 const launch=async()=>{const env={...process.env,MAILGRID_DATA_DIR:dir};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({...(process.env.MAILGRID_TEST_EXECUTABLE?{executablePath:process.env.MAILGRID_TEST_EXECUTABLE}:{}),args:process.env.MAILGRID_TEST_EXECUTABLE?['--test-mode']:[root,'--preview','--test-mode'],env});const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.getByText('Mail service running',{exact:true}).waitFor();return page};
 try{
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({ports:{smtp:await free(),imap:await free(),pop3:await free()},startAtLogin:false,notificationsEnabled:false}));
  let page=await launch();await page.evaluate(()=>window.mailgrid.request('accounts.create',{address:'test@mailgrid.test',password:'a'}));
  const text='First line — 日本語\n<script>window.__plainBad=true</script> & <b>literal</b>\nhttps://example.test/preview';
  for(const message of [{subject:'Plain only',text},{subject:'Whitespace HTML',text,html:'   \n '},{subject:'Prefer HTML',text:'PLAIN ALTERNATIVE',html:'<h1>Preferred HTML body</h1>'},{subject:'Empty body',text:''}])await page.evaluate(message=>window.mailgrid.request('compose.send',{from:'test@mailgrid.test',to:['unknown@example.test'],...message}),message);
  for(const subject of ['Plain only','Whitespace HTML']){
   await page.getByRole('button',{name:new RegExp(subject)}).click();await page.getByRole('button',{name:'HTML preview',exact:true}).click();const frame=page.frameLocator('iframe');await frame.getByText('First line — 日本語',{exact:false}).waitFor();assert.equal((await frame.locator('body').innerText()).trim(),text);assert.equal(await frame.locator('script,b').count(),0);assert.equal(await frame.getByRole('link').getAttribute('href'),'https://example.test/preview');assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-popups');assert((await page.locator('iframe').getAttribute('srcdoc')).includes("default-src 'none'"));
  }
  await page.getByRole('button',{name:/Prefer HTML/}).click();await page.getByRole('button',{name:'HTML preview',exact:true}).click();await page.frameLocator('iframe').getByRole('heading',{name:'Preferred HTML body'}).waitFor();
  await page.getByRole('button',{name:/Empty body/}).click();await page.getByRole('button',{name:'HTML preview',exact:true}).click();await page.getByText('This email has no readable content.',{exact:true}).waitFor();await page.getByRole('button',{name:'Raw source',exact:true}).click();assert((await page.locator('.preview-body pre').innerText()).includes('Subject: Empty body'));
  await app.close();app=null;page=await launch();await page.getByRole('button',{name:/Plain only/}).click();await page.getByRole('button',{name:'HTML preview',exact:true}).click();await page.frameLocator('iframe').getByText('First line — 日本語',{exact:false}).waitFor();
  await page.screenshot({path:path.join(root,'test-results/plain-text-html-preview.png')});
  console.log('PASS: plain-only and whitespace-HTML fallback, Unicode/newlines/literal hostile markup, safe links/CSP/sandbox, genuine HTML preference, empty content/raw source and restart persistence');
 }finally{if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1});

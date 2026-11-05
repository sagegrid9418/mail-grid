const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const moduleRequire = require('node:module').createRequire(path.join(__dirname, '../dist-electron/mail-notifications.js'));
const {EventEmitter}=require('node:events');
const target={exports:{}};
let supported=true;
const natives=[],popups=[];
class MockNotification extends EventEmitter {
 static isSupported(){return supported;}
 constructor(options){super();this.options=options;natives.push(this);}
 show(){this.shown=true;} close(){this.emit('close');}
}
class MockWindow extends EventEmitter {
 constructor(options){super();this.options=options;this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};popups.push(this);}
 setVisibleOnAllWorkspaces(){} showInactive(){this.shown=true;}
 async loadURL(url){this.url=url;this.emit('ready-to-show');}
 isDestroyed(){return !!this.destroyed;}
 destroy(){this.destroyed=true;this.emit('closed');}
}
const electron={nativeTheme:{shouldUseDarkColors:false},BrowserWindow:MockWindow,Notification:MockNotification,screen:{getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1400,height:900}})}};
new Function('require','module','exports',fs.readFileSync(path.join(__dirname,'../dist-electron/mail-notifications.js'),'utf8'))(name=>name==='electron'?electron:moduleRequire(name),target,target.exports);
const {MailNotifications}=target.exports;
let opened,status;
const service=new MailNotifications(mail=>{opened=mail;},value=>{status=value;});
try{
 const mail={account:'alice@mailgrid.test',subject:'<script>hostile</script>',from:'sender@example.test'};
 service.show(mail);assert(natives[0].shown);
 natives[0].emit('click');assert.equal(opened.account,mail.account);
 natives[0].emit('failed');assert(popups[0].shown);assert(status);
 const html=decodeURIComponent(popups[0].url.split(',').slice(1).join(','));
 assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>hostile'));
 const event={url:'mailgrid-notification://open',preventDefault(){this.prevented=true;}};
 popups[0].webContents.emit('will-navigate',event);assert(event.prevented);assert(popups[0].destroyed);
 supported=false;service.show(mail);assert(popups[1].shown);
 service.close();assert(popups[1].destroyed);
 const silent=new MailNotifications(()=>{},()=>{},true);silent.show(mail);assert.equal(popups.length,2);
 console.log('PASS: system notifications, click-through, safe popup fallback, cleanup, test isolation');
}finally{service.close();}

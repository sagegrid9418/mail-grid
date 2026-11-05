const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleRequire = require('node:module').createRequire(path.join(__dirname, '../dist-electron/content-actions.js'));
const target = { exports: {} };
let copied, opened;
const electron = { clipboard: { writeText: value => { copied=value; } }, shell: { openExternal: async value => { opened=value; } } };
new Function('require','module','exports',fs.readFileSync(path.join(__dirname,'../dist-electron/content-actions.js'),'utf8'))(
 name => name==='electron' ? electron : moduleRequire(name), target, target.exports,
);
const { browserURL, contentMenuItems, openBrowser } = target.exports;
(async () => {
 assert.equal(browserURL('javascript:alert(1)'),null);
 assert.equal(browserURL('file:///etc/passwd'),null);
 assert.equal(browserURL('data:text/html,test'),null);
 assert.equal(browserURL('https://example.test/reset?token=a#step'),'https://example.test/reset?token=a#step');
 const items = contentMenuItems({ linkURL:'https://example.test', selectionText:'selected email text', isEditable:false });
 assert(!items.some(item=>item.role==='selectAll'));
 assert(contentMenuItems({linkURL:'',selectionText:'',isEditable:true}).some(item=>item.role==='selectAll'));
 let feedback=0;contentMenuItems({linkURL:'',selectionText:'text',isEditable:false},()=>feedback++).find(item=>item.label==='Copy').click();assert.equal(feedback,1);
 items.find(item=>item.label==='Copy').click(); assert.equal(copied,'selected email text');
 items.find(item=>item.label==='Copy link address').click(); assert.equal(copied,'https://example.test');
 items.find(item=>item.label==='Open link in browser').click(); assert.equal(opened,'https://example.test/');
 assert(contentMenuItems({linkURL:'',selectionText:'',isEditable:true}).some(item=>item.role==='paste'));
 assert(!contentMenuItems({linkURL:'file:///tmp/test',selectionText:'',isEditable:false}).some(item=>item.label==='Open link in browser'));
 await assert.rejects(()=>openBrowser('file:///tmp/test'));
 console.log('PASS: browser URL validation and selection/link/editable context menu actions');
})().catch(error=>{console.error(error);process.exitCode=1;});

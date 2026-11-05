import fs from 'node:fs';import path from 'node:path';import {collectMessages} from './collect-messages.mjs';
const root=path.resolve(import.meta.dirname,'..'),directory=path.join(root,'assets/locales');
const expected=['en','ar','de','es','fa','fr','ha','he','hi','id','ig','it','ja','ko','nl','pl','pt','ru','sw','uk','yo','zh','zh-Hant'];
const english=collectMessages(root),inventory=JSON.parse(fs.readFileSync(path.join(directory,'inventory.json')));
const unchanged=JSON.parse(fs.readFileSync(path.join(root,'scripts/localization/unchanged.json')));
const tokens=s=>[...s.matchAll(/\{(\w+)\}/g)].map(x=>x[1]).sort().join(',');
const coverage={},complete=[],errors=[];
const plurals=JSON.parse(fs.readFileSync(path.join(directory,'plurals.json')));
const pluralKeys=['{count} messages','{count} unread emails','{count} emails moved to Trash','{count} emails restored to Inbox','{count} emails permanently deleted','{count} emails marked as read','{count} emails marked as unread'];
fs.writeFileSync(path.join(directory,'en.json'),JSON.stringify(english,null,2)+'\n');
for(const language of expected){const file=path.join(directory,language+'.json'),catalog=language==='en'?english:JSON.parse(fs.readFileSync(file,'utf8'));let count=0;
 for(const key of Object.keys(english)){
  const value=catalog[key];if(typeof value!=='string'||!value.trim()){errors.push(`${language}: missing ${key}`);continue}
  if(/(.{8,80})(?:\1){3,}/u.test(value)||value.length>Math.max(300,key.length*5)){errors.push(`${language}: repeated or oversized translation ${key}`);continue}
  if(tokens(key)!==tokens(value)){errors.push(`${language}: interpolation ${key}`);continue}
  if(language!=='en'&&value===key&&!unchanged.global.includes(key)&&!unchanged.languages[language]?.includes(key)){errors.push(`${language}: English placeholder ${key}`);continue}count++;
 }
 if(language!=='en')for(const key of pluralKeys)for(const category of new Intl.PluralRules(language).resolvedOptions().pluralCategories){const value=plurals[language]?.[key]?.[category];if(typeof value!=='string'||tokens(value)!=='count'||value===key){errors.push(`${language}: plural ${key}/${category}`);count=Math.min(count,Object.keys(english).length-1)}}
 coverage[language]={translated:count,total:Object.keys(english).length};if(count===Object.keys(english).length)complete.push(language);
}
const available=locale=>{const l=new Intl.Locale(locale),catalog=l.language==='zh'&&l.maximize().script==='Hant'?'zh-Hant':l.language;return complete.includes(catalog)&&new Intl.Locale(catalog).maximize().script===l.maximize().script};
const supported={cldrVersion:inventory.cldrVersion,catalogs:complete,locales:[...new Set(['en',...inventory.locales.filter(available),...complete])]};
fs.writeFileSync(path.join(directory,'supported.json'),JSON.stringify(supported,null,2)+'\n');
fs.writeFileSync(path.join(root,'src/locales/coverage.json'),JSON.stringify({cldrVersion:inventory.cldrVersion,messages:Object.keys(english).length,catalogs:coverage},null,2)+'\n');
fs.writeFileSync(path.join(root,'scripts/localization/validation-issues.json'),JSON.stringify(errors,null,2)+'\n');
if(errors.length&&!process.argv.includes('--inventory-only'))throw Error(`Offline catalogs are incomplete (${errors.length} issues).\n${errors.slice(0,30).join('\n')}`);
console.log(`Offline catalogs: ${complete.join(', ')}. ${errors.length} outstanding entries.`);

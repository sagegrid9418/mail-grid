// Generate offline selector labels from pinned CLDR 48 English display-name tables.
// Inputs: languages.json scripts.json territories.json from:
// https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/cldr-json/cldr-localenames-full/main/en/
import fs from 'node:fs';
const files=process.argv.slice(2);if(files.length!==3)throw Error('Pass the pinned CLDR languages, scripts and territories JSON files.');
const [languages,scripts,territories]=files.map((file,index)=>JSON.parse(fs.readFileSync(file)).main.en.localeDisplayNames[['languages','scripts','territories'][index]]);
const supplemental={apc:'Levantine Arabic',lld:'Ladin',mhn:'Mòcheno',mww:'Hmong Daw',skr:'Saraiki',suz:'Sunwar'};
const inventory=JSON.parse(fs.readFileSync(new URL('../src/locales/inventory.json',import.meta.url)));
const labels={};
for(const code of inventory.locales){
 const locale=new Intl.Locale(code),base=locale.language||'und';
 const scriptCode=[base,locale.script].filter(Boolean).join('-');
 let name=languages[code]||languages[scriptCode]||supplemental[base]||languages[base];
 if(!name)throw Error('Missing English language name: '+code);
 if(!languages[code]){
  const modifiers=[];
  if(locale.script&&!languages[scriptCode]){if(!scripts[locale.script])throw Error('Missing script name: '+code);modifiers.push(scripts[locale.script]);}
  if(locale.region){if(!territories[locale.region])throw Error('Missing territory name: '+code);modifiers.push(territories[locale.region]);}
  if(code.endsWith('-valencia'))modifiers.push('Valencian');
  if(modifiers.length)name+=' ('+modifiers.join(', ')+')';
 }
 labels[code]=name;
}
labels.zh=languages['zh-Hans'];
fs.writeFileSync(new URL('../src/locales/language-names-en.json',import.meta.url),JSON.stringify({cldrVersion:'48.0.0',source:'https://github.com/unicode-org/cldr-json/tree/48.0.0/cldr-json/cldr-localenames-full/main/en',supplementalSource:'https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry',supplementalDate:'2026-09-17',labels},null,2)+'\n');
console.log('Bundled English labels for all '+Object.keys(labels).length+' supported locales; runtime display-name tables are not required.');

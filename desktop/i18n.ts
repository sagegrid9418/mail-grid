import fs from 'node:fs';
import path from 'node:path';
let dictionary:Record<string,string>={};let language='en';
export const nativeDirection=()=>['ar','fa','he'].includes(language.split('-')[0])?'rtl':'ltr';
export const nativeLanguage=()=>language;
export function loadNativeLanguage(directory:string,locale:string){
 language=locale;const base=locale.split('-')[0];if(!/^[a-z]{2,8}$/.test(base)){dictionary={};return;}
 const parsed=new Intl.Locale(locale);for(const name of [locale,base+'-'+parsed.maximize().script,base]){try{dictionary=JSON.parse(fs.readFileSync(path.join(directory,name+'.json'),'utf8'));return}catch{}}dictionary={};
}
export function t(message:string,values:Record<string,string|number>={}){return (dictionary[message]||message).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match)}

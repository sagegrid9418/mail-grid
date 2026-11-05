import inventory from '../assets/locales/supported.json';
import {languageSupported} from '../desktop/language-support';
import pluralCatalogs from '../assets/locales/plurals.json';
import english from '../assets/locales/en.json';
const catalogs=import.meta.glob(['../assets/locales/*.json','!../assets/locales/en.json','!../assets/locales/inventory.json','!../assets/locales/supported.json','!../assets/locales/plurals.json'],{import:'default'});
let generation=0;
let language='en',dictionary:Record<string,string>={};
const subscribers=new Set<()=>void>();
export const locales=inventory.locales;
export const currentLanguage=()=>language;
export const translationCoverage=()=>({translated:Object.keys(english).filter(key=>dictionary[key]&&dictionary[key]!==key).length,total:Object.keys(english).length});
export const languageDirection=(locale:string)=>['Arab','Hebr','Thaa','Nkoo','Adlm','Rohg','Syrc','Mand','Samr'].includes(new Intl.Locale(locale).maximize().script||'')?'rtl':'ltr';
export const languageName=(locale:string,inLanguage=locale)=>{try{return new Intl.DisplayNames([inLanguage],{type:'language'}).of(locale)||locale}catch{return locale}};
export async function setLanguage(value:string){
 const request=++generation;const selected=languageSupported(value,inventory.catalogs)?value:'en';const locale=new Intl.Locale(selected),script=locale.script||locale.maximize().script;const loader=catalogs[`../assets/locales/${selected}.json`]||catalogs[`../assets/locales/${locale.language}-${script}.json`]||catalogs[`../assets/locales/${locale.language}.json`];
 const loaded=loader?await loader() as Record<string,string>:{};if(request!==generation)return;dictionary={...english,...loaded};language=selected;
 document.documentElement.lang=selected;document.documentElement.dir=languageDirection(selected);
 subscribers.forEach(fn=>fn());
}
export function subscribeLanguage(fn:()=>void){subscribers.add(fn);return()=>{subscribers.delete(fn)}}
export function t(message:string,values:Record<string,string|number>={}){return (dictionary[message]||(dictionary[message.trim()]?message.replace(message.trim(),dictionary[message.trim()]):message)).replace(/\{(\w+)\}/g,(match,key)=>Object.hasOwn(values,key)?String(values[key]):match)}
export const number=(value:number)=>new Intl.NumberFormat(language).format(value);
export function plural(count:number,forms:Partial<Record<Intl.LDMLPluralRule,string>>&{other:string}){const l=new Intl.Locale(language),catalog=l.language==='zh'&&l.maximize().script==='Hant'?'zh-Hant':l.language;const category=new Intl.PluralRules(language).select(count);const entries=pluralCatalogs as Record<string,Record<string,Partial<Record<Intl.LDMLPluralRule,string>>>>;const translated=entries[catalog]?.[forms.other]?.[category];return translated?translated.replace(/\{count\}/g,number(count)):t(forms[category]||forms.other,{count:number(count)})}

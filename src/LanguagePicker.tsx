import {useMemo} from 'react';
import {locales,languageName,t} from './i18n';
import names from './locales/language-names-en.json';
const labels:Record<string,string>=names.labels;
const label=(code:string)=>labels[code]||languageName(code,'en');

export function LanguagePicker({value,onChange}:{value:string;onChange:(language:string)=>void}){
 const options=useMemo(()=>{
  // Regional formatting remains supported; offer each language/script once.
  const identities=new Map<string,string>();
  for(const code of [...locales].sort((a,b)=>a.length-b.length)){const locale=new Intl.Locale(code);const identity=locale.language+'-'+locale.maximize().script;if(!locale.region&&!identities.has(identity))identities.set(identity,code);}
  const codes=new Set(identities.values());
  return ['en',...[...codes].filter(code=>code!=='en').sort((a,b)=>label(a).localeCompare(label(b),'en'))];
 },[]);
 const locale=new Intl.Locale(value),selected=locale.language==='zh'&&locale.maximize().script==='Hant'?'zh-Hant':locale.language;
 return <div className="language-picker"><label>{t('Interface language')}<select aria-label={t('Interface language')} value={selected} onChange={e=>onChange(e.target.value)}>{options.map(code=><option key={code} value={code}>{code==='zh'?'Chinese (Simplified)':code==='zh-Hant'?'Chinese (Traditional)':label(code)}</option>)}</select></label><p className="field-help">{t('All interface languages work offline. Email contents are not translated.')}</p></div>
}

export function languageSupported(locale:string,catalogs:readonly string[]){
 try{const parsed=new Intl.Locale(locale),script=parsed.maximize().script;const catalog=parsed.language==='zh'&&script==='Hant'?'zh-Hant':parsed.language;return catalogs.includes(catalog)&&new Intl.Locale(catalog).maximize().script===script}catch{return false}
}

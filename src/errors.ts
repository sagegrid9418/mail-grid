import {t} from './i18n';
export function errorMessage(cause:unknown){
 const message=String(cause).replace(/^Error:\s*/,'').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/,'');
 const status=message.match(/^The release server returned (\d+)\. Try again later\.$/);
 if(status)return t('The release server returned {status}. Try again later.',{status:status[1]});
 const preparation='The update could not be prepared. Your current app is still running.';
 if(message.startsWith(preparation))return t('The update could not be prepared. Your current app is still running.')+message.slice(preparation.length);
 // Known normal errors translate; OS/protocol diagnostic details retain their original text.
 return t(message);
}

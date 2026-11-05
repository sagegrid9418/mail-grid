import {useEffect,useState,useSyncExternalStore} from 'react';
import App from './App';
import {errorMessage} from './errors';
import {FirstLaunch} from './FirstLaunch';
import {setLanguage,subscribeLanguage,currentLanguage,t} from './i18n';
import type {SetupChoices} from '../desktop/preferences';
export function DesktopRoot(){
 useSyncExternalStore(subscribeLanguage,currentLanguage);
 const [profile,setProfile]=useState<{completed:boolean;choices:SetupChoices;migrationNotice?:boolean}|null>(null),[error,setError]=useState('');
 const load=()=>window.mailgrid.request<{completed:boolean;choices:SetupChoices;migrationNotice?:boolean}>('onboarding.get').then(async value=>{await setLanguage(value.choices.language);setProfile(value)}).catch(cause=>setError(errorMessage(cause)));
 useEffect(()=>{void load()},[]);
 useEffect(()=>{if(profile?.completed){const frame=requestAnimationFrame(()=>{void window.mailgrid.request('updates.confirmStartup').catch(()=>{})});return()=>cancelAnimationFrame(frame)}},[profile?.completed]);
 if(error)return <main className="first-launch"><section><h1>{t('Mail Grid could not open')}</h1><p role="alert">{error}</p><button onClick={()=>{setError('');void load()}}>{t('Retry')}</button></section></main>;
 if(!profile)return <main className="first-launch" role="status">{t('Opening Mail Grid…')}</main>;
 return profile.completed?<App/>:<FirstLaunch migrationNotice={profile.migrationNotice} initial={profile.choices} onComplete={()=>void load()}/>;
}

import fs from 'node:fs';
import path from 'node:path';
export type DesktopPreferences = { language?: string; languageMigrationNotice?:boolean; onboarding?: { completed: true; version: number }; setupDraft?: SetupChoices; theme?: 'system'|'dark'|'light'; expandedAccounts?: Record<string,boolean>; notificationsRequested?: boolean; updates?: {preference:'manual'|'automatic';automaticChecks:boolean} };
export type SetupChoices = {language:string;theme:'system'|'dark'|'light';preference:'manual'|'automatic';automaticChecks:boolean};
export const setupDefaults:SetupChoices={language:'en',theme:'system',preference:'manual',automaticChecks:true};
export function readPreferences(directory:string):DesktopPreferences {try{return JSON.parse(fs.readFileSync(path.join(directory,'desktop-preferences.json'),'utf8'));}catch{return {};}}
export function savePreferences(directory:string,value:DesktopPreferences){fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'desktop-preferences.json');fs.writeFileSync(file+'.tmp',JSON.stringify(value),{mode:0o600});fs.renameSync(file+'.tmp',file);}
export function initializeProfile(directory:string) {
 const prefs=readPreferences(directory);
 if(!prefs.onboarding && !prefs.setupDraft && (prefs.theme || prefs.expandedAccounts || prefs.notificationsRequested || ['settings.json','accounts.db','mailgrid.db','mailgrid.db-wal','mail.db','mailboxes.db'].some(name=>fs.existsSync(path.join(directory,name))))) {
  prefs.onboarding={completed:true,version:1};prefs.language=prefs.language||'en';savePreferences(directory,prefs);
 }
 return prefs;
}
export function validateSetup(value:unknown,locales:Pick<Set<string>,'has'>):SetupChoices {
 const v=value as SetupChoices;
 if(!v || !locales.has(v.language) || !['system','dark','light'].includes(v.theme) || !['manual','automatic'].includes(v.preference) || typeof v.automaticChecks!=='boolean')throw Error('Choose a valid language, theme and update preference.');
 return {language:v.language,theme:v.theme,preference:v.preference,automaticChecks:v.automaticChecks};
}

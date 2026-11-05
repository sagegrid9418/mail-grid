import {EventEmitter} from 'node:events';
import {app} from 'electron';
import fs from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ReleaseSource,hasRole,type ReleaseFile} from './releases';
import type {UpdateAdapter} from './updates';
import {UpdateDownload} from './update-download';
const execute=promisify(execFile);
export class MacUpdateAdapter extends EventEmitter implements UpdateAdapter {
 autoDownload=false;autoInstallOnAppQuit=false;allowDowngrade=false;allowPrerelease=false;disableWebInstaller=true;
 readonly transfer:UpdateDownload;private directory?:string;private artifact?:string;private plan?:string;
 constructor(private source:ReleaseSource){super();this.transfer=new UpdateDownload(source,path.join(app.getPath('userData'),'updates','downloads'));this.transfer.on('transfer-state',value=>this.emit('transfer-state',value))}
 checkForUpdates(){return this.source.latest()}
 cancelDownload(){return this.transfer.cancel()}
 pauseDownload(){return this.transfer.pause()}
 private expected():ReleaseFile {
  const {release,target}=this.source.current;
  const file=target?.files.find(file=>hasRole(file,'update')&&file.name.endsWith('.dmg'));
  if(release?.schema!==2||target?.arch!=='universal'||!file)throw Error('This Mac release needs a universal DMG. Ask the maintainer for an updated installer.');
  return file;
 }
 async downloadUpdate(){
  const file=this.expected();const cached=await this.transfer.download();
  if(this.directory&&!this.plan)await fs.rm(this.directory,{recursive:true,force:true});
  const root=path.join(app.getPath('userData'),'updates');await fs.mkdir(root,{recursive:true,mode:0o700});
  // Discard abandoned staging copies, retaining every journaled installation/recovery.
  for(const name of await fs.readdir(root)){if(!name.startsWith('install-'))continue;const directory=path.join(root,name);if((await fs.lstat(directory)).isSymbolicLink())continue;if(!await fs.stat(path.join(directory,'plan.json')).then(()=>true,()=>false))await fs.rm(directory,{recursive:true,force:true})}
  this.directory=await fs.mkdtemp(path.join(root,'install-'));await fs.chmod(this.directory,0o700);
  this.artifact=path.join(this.directory,file.name);await fs.copyFile(cached,this.artifact);await fs.chmod(this.artifact,0o600);
 }

 async prepareInstall(){
  this.expected();if(!this.directory||!this.artifact||!this.source.envelope)throw Error('Download and verify the update first.');
  await this.transfer.confirm(this.artifact);
  const installed=await fs.realpath(path.resolve(process.resourcesPath,'../..'));
  if(path.basename(installed)!=='Mail Grid.app'||installed.startsWith('/Volumes/'))throw Error('Move Mail Grid into Applications before updating.');
  const helper=path.join(this.directory,'mailgrid-updater');await fs.copyFile(path.join(process.resourcesPath,'mailgrid-updater'),helper);await fs.chmod(helper,0o700);
  this.plan=path.join(this.directory,'plan.json');
  await fs.writeFile(this.plan,JSON.stringify({app:installed,artifact:this.artifact,token:randomBytes(32).toString('hex'),parent:process.pid,profile:await fs.realpath(app.getPath('userData')),testMode:process.argv.includes('--test-mode'),envelope:this.source.envelope,phase:'prepared'}),{mode:0o600});
  try{await execute(helper,['--check',this.plan],{timeout:120000,maxBuffer:1024*1024})}catch(error){throw Error(`The update could not be prepared. Your current app is still running. ${error instanceof Error?error.message:''}`)}
 }
 async quitAndInstall(){
  if(!this.directory||!this.plan)throw Error('Prepare the update first.');
  const child=spawn(path.join(this.directory,'mailgrid-updater'),['--run',this.plan],{detached:true,stdio:'ignore'});
  await new Promise<void>((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();app.quit();
 }
}
export async function acknowledgeMacUpdate(){
 const tokenIndex=process.argv.indexOf('--mailgrid-update-token'),workIndex=process.argv.indexOf('--mailgrid-update-work');
 if(tokenIndex<0||workIndex<0)return;
 const token=process.argv[tokenIndex+1],work=process.argv[workIndex+1];if(!/^[a-f0-9]{64}$/.test(token||'')||!work)return;
 const root=await fs.realpath(path.join(app.getPath('userData'),'updates'));
 const directory=await fs.realpath(work);if(path.dirname(directory)!==root)return;
 const plan=JSON.parse(await fs.readFile(path.join(directory,'plan.json'),'utf8'));
 if(plan.token!==token||plan.app!==await fs.realpath(path.resolve(process.resourcesPath,'../..')))return;
 await fs.writeFile(path.join(directory,'health.json'),JSON.stringify({token,version:app.getVersion(),pid:process.pid}),{mode:0o600});
}

export async function finishMacRecovery(){
 const root=path.join(app.getPath('userData'),'updates');
 for(const name of await fs.readdir(root).catch(()=>[] as string[])){
  if(!name.startsWith('install-'))continue;const work=path.join(root,name),file=path.join(work,'plan.json');
  try{
   if((await fs.lstat(work)).isSymbolicLink())continue;
   const plan=JSON.parse(await fs.readFile(file,'utf8'));if(!['exchanging','backup','installed'].includes(plan.phase)||!/^([a-f0-9]{64})$/.test(plan.token))continue;
   if(plan.app!==await fs.realpath(path.resolve(process.resourcesPath,'../..')))continue;
   const release=JSON.parse(Buffer.from(plan.envelope.payload,'base64').toString('utf8'));
   if(release.version===app.getVersion())await fs.writeFile(path.join(work,'health.json'),JSON.stringify({token:plan.token,version:app.getVersion(),pid:process.pid}),{mode:0o600});
   const executable=path.join(work,'mailgrid-updater');await fs.copyFile(path.join(process.resourcesPath,'mailgrid-updater'),executable+'.fresh');await fs.chmod(executable+'.fresh',0o700);await fs.rename(executable+'.fresh',executable);
   await execute(executable,['--recover',file],{timeout:15000,maxBuffer:1024*1024});
  }catch(error){console.error('Update recovery:',error)}
 }
}

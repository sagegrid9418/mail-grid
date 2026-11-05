import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {ReleaseSource, hasRole, targetID, verifyRelease, type Release, type ReleaseFile, type ReleaseEnvelope} from './releases';

type Identity = {origin:string;version:string;target:string;file:ReleaseFile};
type Journal = {schema:1;identity:Identity;release:Release;envelope:ReleaseEnvelope|null;status:'active'|'paused'|'cancelled'|'ready'|'blocked';saved:number;rangeSupport?:boolean};
export type TransferProgress = {phase:'downloading'|'retrying'|'verifying';savedBytes:number;totalBytes:number;resumable:boolean;retryAt?:string;notice?:string};
class PermanentDownloadError extends Error {}
export class SavedDownloadStopped extends Error {}

/** One profile-private, crash-safe transfer cache. Native installers consume only verified files. */
export class UpdateDownload extends EventEmitter {
 private controller?:AbortController;
 private running?:Promise<string>;
 private remembering?:Promise<void>;
 private journal?:Journal;
 private saving:Promise<void>=Promise.resolve();
 constructor(private source:ReleaseSource,readonly directory:string,private retryBase=2000){super()}
 private get journalPath(){return path.join(this.directory,'transfer.json')}
 private get partial(){return path.join(this.directory,'artifact.partial')}
 private get complete(){return path.join(this.directory,'artifact.verified')}
 private identity():Identity {
  const {release,target}=this.source.current;const file=target?.files.find(f=>hasRole(f,'update'));
  if(!release||!target||!file)throw new PermanentDownloadError('This release has changed or was withdrawn. Check for updates again.');
  return {origin:new URL(this.source.options.origin).origin,version:release.version,target:targetID(target),file};
 }
 private save(){this.saving=this.saving.catch(()=>{}).then(async()=>{try{await this.writeJournal()}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOSPC')throw error;await fs.rm(path.join(this.directory,'journal-reserve'),{force:true});await this.writeJournal()}});return this.saving}
 private async writeJournal(){
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});
  const temporary=this.journalPath+'.new';const handle=await fs.open(temporary,'w',0o600);
  try{await handle.writeFile(JSON.stringify(this.journal));await handle.sync()}finally{await handle.close()}
  await fs.rename(temporary,this.journalPath);
  // Keep a small reserve so a disk-full failure can still record Pause/Cancel.
  await fs.writeFile(path.join(this.directory,'journal-reserve'),Buffer.alloc(1024*1024),{flag:'wx',mode:0o600}).catch(()=>{});
 }
 async saved(){
  if(this.journal)return this.journal;
  try{
   const j=JSON.parse(await fs.readFile(this.journalPath,'utf8')) as Journal;
   if(j.schema!==1||j.identity.origin!==new URL(this.source.options.origin).origin||!['active','paused','cancelled','ready','blocked'].includes(j.status)||!Number.isSafeInteger(j.saved)||j.saved<0||j.saved>j.identity.file.size)throw Error();
   const release=verifyRelease(j.envelope!,this.source.options.keys,this.source.options.origin);const target=release.targets.find(t=>targetID(t)===j.identity.target);if(release.version!==j.identity.version||!target||JSON.stringify(target.files.find(f=>hasRole(f,'update')))!==JSON.stringify(j.identity.file))throw Error();
   j.release=release;this.journal=j;return j;
  }catch{return undefined}
 }
 remember(){const task=this.rememberIntent();this.remembering=task;return task.finally(()=>{if(this.remembering===task)this.remembering=undefined})}
 private async rememberIntent(){const identity=this.identity(),old=await this.saved();if(old&&JSON.stringify(old.identity)===JSON.stringify(identity)){old.status='active';await this.save();return}if(old&&old.identity.version===identity.version&&old.status!=='cancelled')throw new PermanentDownloadError('This release has changed or was withdrawn. Check for updates again.');await fs.mkdir(this.directory,{recursive:true,mode:0o700});await Promise.all([fs.rm(this.partial,{force:true}),fs.rm(this.complete,{force:true})]);this.journal={schema:1,identity,release:this.source.current.release!,envelope:this.source.envelope,status:'active',saved:0};await this.save()}
 async suppressed(){const j=await this.saved();return !!j&&['cancelled','paused','blocked'].includes(j.status)&&JSON.stringify(j.identity)===JSON.stringify(this.identity())}
 async pause(){this.controller?.abort();await this.remembering?.catch(()=>{});if(!this.journal)await this.saved();if(!this.journal)return;this.journal.status='paused';this.controller?.abort();await this.running?.catch(()=>{});await this.save()}
 async cancel(){this.controller?.abort();await this.remembering?.catch(()=>{});if(!this.journal)await this.saved();if(!this.journal)return;this.journal.status='cancelled';this.controller?.abort();await this.running?.catch(()=>{});this.journal.saved=0;await this.save();await Promise.all([fs.rm(this.partial,{force:true}),fs.rm(this.complete,{force:true})])}
 async discard(){await this.cancel();await fs.rm(this.directory,{recursive:true,force:true});this.journal=undefined}
 stop(){this.controller?.abort();return this.running?.then(()=>{},()=>{})||Promise.resolve()}
 download():Promise<string>{
  if(this.running)return this.running;
  this.running=this.run().finally(()=>{this.running=undefined});return this.running;
 }
 private progress(phase:TransferProgress['phase'],extra:Partial<TransferProgress>={}){const j=this.journal!;this.emit('transfer-state',{phase,savedBytes:j.saved,totalBytes:j.identity.file.size,resumable:j.rangeSupport!==false,...extra} satisfies TransferProgress)}
 private async validate(identity:Identity,signal:AbortSignal){
  try{await this.source.latest(signal)}catch(error){if(error instanceof Error&&!/Could not reach|server returned (?:408|429|5\d\d)/.test(error.message))throw new PermanentDownloadError(error.message);throw error}
  if(JSON.stringify(this.identity())!==JSON.stringify(identity))throw new PermanentDownloadError('This release has changed or was withdrawn. Check for updates again.');
 }
 private async verify(file:string,signal:AbortSignal){
  const expected=this.journal!.identity.file;const handle=await fs.open(file,'r');const a=createHash('sha256'),b=createHash('sha512');let size=0;
  try{for await(const chunk of handle.createReadStream({autoClose:false})){if(signal.aborted)throw new SavedDownloadStopped('Download stopped.');size+=chunk.length;a.update(chunk);b.update(chunk)}}finally{await handle.close()}
  return size===expected.size&&a.digest('hex')===expected.sha256&&b.digest('base64')===expected.sha512;
 }
 async confirm(file:string){if(!await this.saved()||!await this.verify(file,new AbortController().signal))throw new PermanentDownloadError('The update checksum did not match. Nothing was installed.')}
 private async run(){
  this.controller=new AbortController();const signal=this.controller.signal;
  const identity=this.identity(),old=await this.saved();if(signal.aborted)throw new SavedDownloadStopped('Download stopped.');
  if(old&&old.identity.version===identity.version&&old.status!=='cancelled'&&JSON.stringify(old.identity)!==JSON.stringify(identity)){old.status='blocked';await this.save();throw new PermanentDownloadError('This release has changed or was withdrawn. Check for updates again.')}
  if(!old||JSON.stringify(old.identity)!==JSON.stringify(identity)){
   await fs.mkdir(this.directory,{recursive:true,mode:0o700});await Promise.all([fs.rm(this.partial,{force:true}),fs.rm(this.complete,{force:true})]);
   this.journal={schema:1,identity,release:this.source.current.release!,envelope:this.source.envelope,status:'active',saved:0};
  }else this.journal!.status='active';
  await this.save();let failures=0;
  while(!signal.aborted){
   try{
    await this.validate(identity,signal);
    if(await fs.stat(this.complete).then(()=>true,()=>false)){
     this.progress('verifying');if(await this.verify(this.complete,signal)){if(signal.aborted)break;this.journal!.saved=identity.file.size;this.journal!.status='ready';await this.save();return this.complete}
     await fs.rm(this.complete,{force:true});this.journal!.saved=0;await this.save();
    }
    await this.transfer(signal);
    if(signal.aborted)break;
    this.progress('verifying');
    if(!await this.verify(this.partial,signal)){await fs.rm(this.partial,{force:true});this.journal!.saved=0;throw new PermanentDownloadError('The update checksum did not match. Nothing was installed.')}
    if(signal.aborted)break;await fs.rename(this.partial,this.complete);this.journal!.status='ready';await this.save();return this.complete;
   }catch(error){
    if(signal.aborted)break;
    const disk=(error as NodeJS.ErrnoException).code==='ENOSPC';
    if(error instanceof PermanentDownloadError||disk){this.journal!.status=disk?'paused':'blocked';await this.save().catch(error=>{if(!disk)throw error});throw disk?new Error('Free disk space, then choose Resume. Your downloaded progress is saved.'):error}
    const delay=Math.min(60000,this.retryBase*2**Math.min(failures++,6));
    this.progress('retrying',{retryAt:new Date(Date.now()+delay).toISOString()});
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve()};const timer=setTimeout(done,delay);signal.addEventListener('abort',done,{once:true})});
   }
  }
  throw new SavedDownloadStopped('Download stopped.');
 }
 private async transfer(signal:AbortSignal){
  const j=this.journal!,file=j.identity.file;
  const size=await fs.stat(this.partial).then(s=>s.size,()=>0);j.saved=Math.min(j.saved,size);
  const handle=await fs.open(this.partial,size?'r+':'w+',0o600);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;const stalled=new AbortController();let timeout:NodeJS.Timeout;const touch=()=>{clearTimeout(timeout);timeout=setTimeout(()=>stalled.abort(),30000)};touch();
  try{
   await handle.truncate(j.saved);
   const capacity=await fs.statfs(this.directory);
   if(Number(capacity.bavail)*Number(capacity.bsize)<file.size-j.saved+64*1024*1024){const error=new Error('Insufficient space') as NodeJS.ErrnoException;error.code='ENOSPC';throw error}
   if(j.saved===file.size)return;
   const offset=j.saved,etag='"'+file.sha256+'"';
   const response=await fetch(new URL(file.url,j.identity.origin),{redirect:'error',signal:AbortSignal.any([signal,stalled.signal]),headers:{'Accept-Encoding':'identity',...(offset?{Range:`bytes=${offset}-`,'If-Range':etag}:{})}});
   if(response.status===404||response.status===410)throw new PermanentDownloadError('This release has changed or was withdrawn. Check for updates again.');
   if(response.status>=400&&response.status<500&&![408,429].includes(response.status))throw new PermanentDownloadError('The update server rejected the download. Check for updates again.');
   if(!response.ok||!response.body)throw Error('Download connection failed.');
   if(response.headers.get('content-encoding')&&response.headers.get('content-encoding')!=='identity')throw new PermanentDownloadError('The update server returned an invalid byte range. Nothing was installed.');
   if(response.status===206){
    j.rangeSupport=true;
    const range=response.headers.get('content-range');
    if(range!==`bytes ${offset}-${file.size-1}/${file.size}`)throw new PermanentDownloadError('The update server returned an invalid byte range. Nothing was installed.');
   }else if(response.status===200){
    if(offset){j.rangeSupport=false;j.saved=0;await handle.truncate(0);await this.save();this.progress('downloading',{notice:'The server does not support resuming. Download restarted safely.'})}
   }else throw new PermanentDownloadError('The update server returned an invalid byte range. Nothing was installed.');
   const length=response.headers.get('content-length');
   if(length!==null&&Number(length)!==file.size-j.saved)throw new PermanentDownloadError('The update is larger or smaller than its verified metadata.');
   reader=response.body.getReader();let checkpoint=Date.now(),confirmed=j.saved;
   this.progress('downloading');
   try{
    while(!signal.aborted){
     const {done,value}=await reader.read();if(done)break;touch();
     if(j.saved+value.length>file.size)throw new PermanentDownloadError('The update is larger or smaller than its verified metadata.');
     let written=0;while(written<value.length){const result=await handle.write(value,written,value.length-written,j.saved);if(!result.bytesWritten)throw Error('Write failed');written+=result.bytesWritten;j.saved+=result.bytesWritten}
     if(Date.now()-checkpoint>1000||j.saved-confirmed>=1048576){await handle.sync();await this.save();checkpoint=Date.now();confirmed=j.saved}
     this.progress('downloading');
    }
   }finally{await handle.sync();await this.save()}
   if(j.saved!==file.size&&!signal.aborted)throw Error('Download interrupted');
  }finally{clearTimeout(timeout!);await reader?.cancel().catch(()=>{});await handle.close()}
 }
}

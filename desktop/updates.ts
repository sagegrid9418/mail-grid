import { EventEmitter } from 'node:events';
import semver from 'semver';
import type {UpdateDownload,TransferProgress} from './update-download';
import { ReleaseSource, type Release, type ReleaseTarget, type UpdateMode, type UpdatePreference, hasRole } from './releases';

export type UpdateSnapshot = {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'paused' | 'retrying' | 'verifying' | 'ready' | 'installing' | 'unsupported' | 'error';
  currentVersion: string; preference: UpdatePreference; automaticChecks: boolean; effectiveMode: UpdateMode;
  release?: Pick<Release, 'version' | 'title' | 'notes' | 'publishedAt'>; size?: number; progress?: number; savedBytes?:number; totalBytes?:number; resumable?:boolean; retryAt?:string; notice?:string; checkedAt?: string; error?: string;
};
export interface UpdateAdapter extends EventEmitter {
  autoDownload: boolean; autoInstallOnAppQuit: boolean; allowDowngrade: boolean; allowPrerelease: boolean; disableWebInstaller: boolean;
  checkForUpdates(): Promise<unknown>; downloadUpdate(): Promise<unknown>; quitAndInstall(): void | Promise<void>; prepareInstall?(): Promise<void>; cancelDownload(): void | Promise<void>; pauseDownload?():void | Promise<void>; transfer?:UpdateDownload;
}
export class Updates {
  state: UpdateSnapshot;
  private closed=false;
  private checking?: Promise<UpdateSnapshot>;
  private downloaded?: { release: Release; target: ReleaseTarget };
  private downloadEpoch = 0;
  private timer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;
  private retryTimer?:NodeJS.Timeout;
  private retries=0;
  private installation?: Promise<UpdateSnapshot>;
  constructor(private options: {
    version: string; source: ReleaseSource; adapter: UpdateAdapter; supported: boolean; unsupportedReason?: string;
    preferences: { preference?: UpdatePreference | 'inherit'; automaticChecks?: boolean };
    persist: (preferences: { preference: UpdatePreference; automaticChecks: boolean }) => void;
    emit: (state: UpdateSnapshot) => void; stopEngine: () => Promise<void>; recoverEngine: () => Promise<void>;
  }) {
    const preference: UpdatePreference = options.preferences.preference === 'automatic' ? 'automatic' : 'manual';
    this.state = { phase: options.supported ? 'idle' : 'unsupported', currentVersion: options.version, preference, automaticChecks: options.preferences.automaticChecks !== false, effectiveMode: preference, ...(!options.supported ? { error: options.unsupportedReason || 'Update service is not configured for this installation. Install the latest Mail Grid installer.' } : {}) };
    if (options.preferences.preference !== preference) options.persist({ preference, automaticChecks: this.state.automaticChecks });
    Object.assign(options.adapter, { autoDownload: false, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false, disableWebInstaller: true });
    options.adapter.on('download-progress', (value: { percent: number }) => this.set({ progress: Math.max(0, Math.min(100, value.percent)) }));
    options.adapter.on('transfer-state',(value:TransferProgress)=>{if(['downloading','retrying','verifying'].includes(this.state.phase))this.set({...value,progress:value.savedBytes/value.totalBytes*100})});
    // Consume adapter errors; check/download callers decide whether to surface them.
    options.adapter.on('error', (error: Error) => { if (this.state.phase === 'installing') { void options.recoverEngine().finally(() => this.set({ phase: 'ready', error: error.message || 'Installation failed. Your current version is still installed.' })); } });
  }
  private set(value: Partial<UpdateSnapshot>) { this.state = { ...this.state, ...value }; this.options.emit(this.state); return this.state; }
  start() {
    if (!this.options.supported) return;
    this.closed=false;void this.restore();
    this.timer = setTimeout(() => { if (this.state.automaticChecks) void this.check(false); }, 30000 + Math.random() * 30000); this.timer.unref();
    this.interval = setInterval(() => { if (this.state.automaticChecks) void this.check(false); }, 6 * 60 * 60 * 1000); this.interval.unref();
  }
  close() { this.closed=true;this.downloadEpoch++;clearTimeout(this.timer); clearInterval(this.interval);clearTimeout(this.retryTimer);return this.options.adapter.transfer?.stop()||Promise.resolve(); }
  private async restore(){
    const saved=await this.options.adapter.transfer?.saved();
    if(this.closed||!saved)return;
    if(!semver.gt(saved.identity.version,this.options.version)){await this.options.adapter.transfer?.discard();return}
    if(['cancelled','blocked'].includes(saved.status))return;
    this.options.source.current={release:saved.release,target:saved.release.targets.find(t=>t.platform+'/'+t.arch+'/'+t.packageType===saved.identity.target)||null};
    this.options.source.envelope=saved.envelope;
    this.set({phase:saved.status==='paused'?'paused':'available',release:saved.release,size:saved.identity.file.size,totalBytes:saved.identity.file.size,savedBytes:saved.saved,progress:saved.saved/saved.identity.file.size*100,resumable:saved.rangeSupport!==false});
    if(saved.status!=='paused')void this.download(false);
  }
  preferences(value: { preference: UpdatePreference; automaticChecks: boolean }) {
    if (!['manual', 'automatic'].includes(value?.preference) || typeof value.automaticChecks !== 'boolean') throw new Error('Invalid update preferences.');
    this.options.persist(value);
    this.set({ ...value, effectiveMode: value.preference });
    return this.state;
  }
  async check(interactive = true): Promise<UpdateSnapshot> {
    if (!this.options.supported || ['downloading', 'retrying','paused','verifying','installing', 'ready'].includes(this.state.phase)) return this.state;
    if (this.checking) return this.checking;
    const previous = this.state;
    this.set({ phase: 'checking', error: undefined });
    this.checking = (async () => {
      try {
        await this.options.adapter.checkForUpdates();
        const { release, target } = this.options.source.current;
        const available = !!release && !!target && semver.gt(release.version, this.options.version);
        this.set({ phase: available ? 'available' : 'idle', effectiveMode: this.state.preference, release: available ? release : undefined, size: target?.files.find(file => hasRole(file,'update'))?.size, checkedAt: new Date().toISOString(), progress: undefined });
        if (available && this.state.effectiveMode === 'automatic' && !await this.options.adapter.transfer?.suppressed()) await this.download(false);
      } catch (error) { if (interactive) this.set({ phase: 'error', error: error instanceof Error ? error.message : 'Could not check for updates.' }); else this.set({ ...previous }); }
      finally { this.checking = undefined; }
      return this.state;
    })();
    return this.checking;
  }
  async download(explicit=true) {
    if (!['available', 'error','paused'].includes(this.state.phase) || !this.state.release) throw new Error('Check for a compatible update first.');
    clearTimeout(this.retryTimer);const epoch = ++this.downloadEpoch;
    this.set({ phase: 'downloading', progress: this.state.progress||0, error: undefined,notice:undefined,retryAt:undefined });
    try {
      if(this.options.source.current.release?.version===this.state.release.version)await this.options.adapter.transfer?.remember();
      if(epoch!==this.downloadEpoch)return this.state;
      // Refresh the provider immediately before downloading to reject withdrawn versions.
      await this.options.adapter.checkForUpdates();
      if (epoch !== this.downloadEpoch) return this.state;
      const { release, target } = this.options.source.current;
      if (!release || !target || release.version !== this.state.release.version) throw new Error('This release has changed or was withdrawn. Check for updates again.');
      await this.options.adapter.downloadUpdate();
      if (epoch !== this.downloadEpoch) return this.state;
      this.retries=0;this.downloaded = { release, target };
      return this.set({ phase: 'ready', progress: 100 });
    } catch (error) {
      if(epoch!==this.downloadEpoch)return this.state;
      if((error as NodeJS.ErrnoException).code==='ENOSPC'){await Promise.resolve(this.options.adapter.pauseDownload?.()).catch(()=>{});return this.set({phase:'paused',error:'Free disk space, then choose Resume. Your downloaded progress is saved.'})}
      const saved=await this.options.adapter.transfer?.saved();
      if(saved)this.set({savedBytes:saved.saved,totalBytes:saved.identity.file.size,progress:saved.saved/saved.identity.file.size*100,resumable:saved.rangeSupport!==false});
      const network=error instanceof Error&&/Could not reach|server returned (?:408|429|5\d\d)/.test(error.message);
      if(network&&saved?.status==='active'){
        const delay=Math.min(60000,2000*2**Math.min(this.retries++,6));
        this.set({phase:'retrying',retryAt:new Date(Date.now()+delay).toISOString(),savedBytes:saved.saved,totalBytes:saved.identity.file.size,resumable:true});
        this.retryTimer=setTimeout(()=>{if(epoch!==this.downloadEpoch)return;this.set({phase:'available'});void this.download(false)},delay);this.retryTimer.unref();
      }else this.set({phase:saved?.status==='paused'?'paused':'error',error:error instanceof Error?error.message:'Update download failed.'});
      return this.state;
    }
  }

  async pause(){
    if(!['downloading','retrying','verifying'].includes(this.state.phase))return this.state;
    this.downloadEpoch++;clearTimeout(this.retryTimer);this.set({phase:'paused',retryAt:undefined});await this.options.adapter.pauseDownload?.();const saved=await this.options.adapter.transfer?.saved();if(saved)this.set({savedBytes:saved.saved,progress:saved.saved/saved.identity.file.size*100});return this.state;
  }
  async cancel() {
    if (!['downloading','paused','retrying','verifying','error'].includes(this.state.phase)) return this.state;
    this.downloadEpoch++;clearTimeout(this.retryTimer);this.set({phase:'available',progress:undefined,savedBytes:0,retryAt:undefined,error:undefined});await this.options.adapter.cancelDownload();return this.state;
  }
  async install() {
    if (this.installation) return this.installation;
    this.installation = this.installApproved();
    try { return await this.installation; } finally { this.installation = undefined; }
  }
  private async installApproved() {
    if (this.state.phase !== 'ready' || !this.downloaded) throw new Error('Download and verify an update first.');
    const downloaded = this.downloaded;
    const current = await this.options.source.latest();
    if (!current.release || !current.target || JSON.stringify(current.target) !== JSON.stringify(downloaded.target) || current.release.version !== downloaded.release.version) { this.downloaded = undefined; this.set({ phase: 'error', error: 'The downloaded release was withdrawn or changed. Check for updates again.' }); return this.state; }
    this.set({ phase: 'installing', error: undefined });
    try { await this.options.adapter.prepareInstall?.(); await this.options.stopEngine(); await this.options.adapter.quitAndInstall(); }
    catch (error) { await this.options.recoverEngine().catch(() => {}); this.set({ phase: error instanceof Error&&error.message==='The update checksum did not match. Nothing was installed.'?'error':'ready', error: error instanceof Error ? error.message : 'Installation could not start.' }); }
    return this.state;
  }
}

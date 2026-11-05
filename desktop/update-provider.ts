import { AppImageUpdater, DebUpdater, NsisUpdater, type AppUpdater } from 'electron-updater';
import { Provider, type ProviderRuntimeOptions, resolveFiles, findFile } from 'electron-updater/out/providers/Provider';
import { CancellationToken, type UpdateInfo } from 'builder-util-runtime';
import {app} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {DownloadUpdateOptions} from 'electron-updater/out/AppUpdater';
import {UpdateDownload} from './update-download';
import {MacUpdateAdapter} from './mac-update-adapter';
import { ReleaseSource,hasRole } from './releases';
import type { UpdateAdapter } from './updates';


export function createUpdateAdapter(source: ReleaseSource, version: string, localConfig?: string): UpdateAdapter {
  if(source.options.platform==='darwin')return new MacUpdateAdapter(source);
  class SignedProvider extends Provider<UpdateInfo> {
    constructor(_configuration: unknown, _updater: unknown, runtime: ProviderRuntimeOptions) { super({ ...runtime, isUseMultipleRangeRequest: false }); }
    async getLatestVersion(): Promise<UpdateInfo> {
      const { release, target } = await source.latest();
      if (!release || !target) return { version, releaseDate: new Date(0).toISOString(), files: [], path: '', sha512: '' };
      const files = target.files.filter(file => hasRole(file,'update')).map(file => ({ url: new URL(file.url, source.options.origin).href, sha512: file.sha512, size: file.size }));
      return { version: release.version, releaseName: release.title, releaseNotes: release.notes, releaseDate: release.publishedAt, minimumSystemVersion: target.minimumSystemVersion, files, path: files[0].url, sha512: files[0].sha512 };
    }
    resolveFiles(info: UpdateInfo) { return resolveFiles(info, new URL(source.options.origin)); }
    override setRequestHeaders() { super.setRequestHeaders(null); }
  }
  const transfer=new UpdateDownload(source,path.join(app.getPath('userData'),'updates','downloads'));
  const prepare=async(options:DownloadUpdateOptions,extension:string)=>{
    const cached=await transfer.download();
    const fileInfo=findFile(options.updateInfoAndProvider.provider.resolveFiles(options.updateInfoAndProvider.info),extension)!;
    if(!fileInfo||fileInfo.packageInfo)throw Error('This update requires a complete installer.');
    return {fileExtension:extension,fileInfo,downloadUpdateOptions:options,task:async(destination:string)=>{await fs.copyFile(cached,destination);if(extension==='AppImage')await fs.chmod(destination,0o755)}};
  };
  class ResumableNsis extends NsisUpdater {protected override async doDownloadUpdate(options:DownloadUpdateOptions){return this.executeDownload(await prepare(options,'exe'))}}
  class ResumableDeb extends DebUpdater {protected override async doDownloadUpdate(options:DownloadUpdateOptions){return this.executeDownload(await prepare(options,'deb'))}}
  class ResumableAppImage extends AppImageUpdater {protected override async doDownloadUpdate(options:DownloadUpdateOptions){return this.executeDownload(await prepare(options,'AppImage'))}}
  const updater: AppUpdater = source.options.platform === 'win32' ? new ResumableNsis() : source.options.packageType === 'deb' ? new ResumableDeb() : new ResumableAppImage();
  transfer.on('transfer-state',value=>(updater as unknown as UpdateAdapter).emit('transfer-state',value));

  if (localConfig) { updater.forceDevUpdateConfig = true; updater.updateConfigPath = localConfig; }
  // Free Ed25519 metadata and artifact hashes authenticate every update.
  // No paid Authenticode certificate is required in this distribution profile.
  if(updater instanceof NsisUpdater)updater.verifyUpdateCodeSignature=async()=>null;
  updater.setFeedURL({ provider: 'custom', updateProvider: SignedProvider });
  if ('disableDifferentialDownload' in updater) updater.disableDifferentialDownload = true;
  let token: CancellationToken | undefined;let installerPath:string|undefined;
  const adapter = updater as unknown as UpdateAdapter;
  const download = updater.downloadUpdate.bind(updater);
  adapter.downloadUpdate = () => { token = new CancellationToken(); return download(token).then(result=>{installerPath=result[0];return result}); };
  adapter.transfer=transfer;
  adapter.prepareInstall=async()=>{if(!installerPath)throw Error('Download and verify an update first.');await transfer.confirm(installerPath)};
  adapter.cancelDownload = async () => {token?.cancel();await transfer.cancel()};
  adapter.pauseDownload = async () => {token?.cancel();await transfer.pause()};
  const install=updater.quitAndInstall.bind(updater);
  adapter.quitAndInstall=()=>install(true,true);
  return adapter;
}

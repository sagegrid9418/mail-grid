import { contextBridge, ipcRenderer } from 'electron';

const allowed = new Set([
  'updates.confirmStartup',
  'onboarding.get','onboarding.draft','onboarding.complete','language.get','language.set',
  'status', 'accounts.list', 'accounts.create', 'accounts.delete', 'accounts.resetPassword', 'accounts.updatePassword', 'accounts.verifyPassword', 'accounts.credentials',
  'folders.list', 'sidebar.get', 'sidebar.update', 'messages.unreadCounts',
  'messages.list', 'messages.get', 'messages.delete', 'messages.update', 'messages.markRead', 'messages.attachment',
  'compose.send', 'settings.get', 'settings.update',
  'updates.get', 'updates.check', 'updates.download', 'updates.cancel','updates.pause','updates.resume', 'updates.install', 'updates.preferences',
]);

contextBridge.exposeInMainWorld('mailgrid', {
  request: (method: string, params: unknown = {}) => {
    if (!allowed.has(method)) return Promise.reject(new Error('Unsupported request'));
    return ipcRenderer.invoke('mailgrid:request', method, params);
  },
  openSystemSettings: (kind: string) => ipcRenderer.invoke('mailgrid:systemSettings', kind),
  testNotification: () => ipcRenderer.invoke('mailgrid:testNotification'),
  relaunch: () => ipcRenderer.invoke('mailgrid:relaunch'),
  restart: () => ipcRenderer.invoke('mailgrid:restart'),
  openExternal: (url: string) => ipcRenderer.invoke('mailgrid:openExternal', url),
  copy: (value: string, label?: string) => ipcRenderer.invoke('mailgrid:copy', value, label),
  onEvent: (callback: (event: string, data: unknown) => void) => {
    const listener = (_: Electron.IpcRendererEvent, event: string, data: unknown) => callback(event, data);
    ipcRenderer.on('mailgrid:event', listener);
    return () => ipcRenderer.removeListener('mailgrid:event', listener);
  },
});

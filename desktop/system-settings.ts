import { shell } from 'electron';
import { spawn } from 'node:child_process';

export type PermissionSettings = 'notifications' | 'startup' | 'privacy';
export async function openSystemSettings(kind: unknown) {
  if (kind !== 'notifications' && kind !== 'startup' && kind !== 'privacy') throw new Error('Unknown system setting.');
  if (process.platform === 'darwin') {
    const panes = { notifications: 'com.apple.preference.notifications', startup: 'com.apple.LoginItems-Settings.extension', privacy: 'com.apple.preference.security?Privacy' };
    await shell.openExternal('x-apple.systempreferences:' + panes[kind]);
    return;
  }
  if (process.platform === 'win32') {
    const pages = { notifications: 'notifications', startup: 'startupapps', privacy: 'privacy' };
    await shell.openExternal('ms-settings:' + pages[kind]);
    return;
  }
  const kde = /kde/i.test(process.env.XDG_CURRENT_DESKTOP || '');
  const args = kde ? [{ notifications: 'kcm_notifications', startup: 'kcm_autostart', privacy: 'kcm_privacy' }[kind]]
    : kind === 'notifications' ? ['notifications'] : kind === 'privacy' ? ['privacy'] : [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(kde ? 'systemsettings' : kind === 'startup' ? 'gnome-session-properties' : 'gnome-control-center', args, { stdio: 'ignore', detached: true });
    child.once('error', () => reject(new Error('Open your desktop’s system settings, then Notifications, Startup Applications, or Privacy, and enable Mail Grid.')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

import {t} from './i18n';
import { clipboard, Menu, shell, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron';

export function browserURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32768) return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export async function openBrowser(value: unknown) {
  const url = browserURL(value);
  if (!url) throw new Error('Only HTTP and HTTPS links can open in the browser.');
  await shell.openExternal(url);
}
export function contentMenuItems(params: ContextMenuParams, copied: (label: string) => void = () => {}): MenuItemConstructorOptions[] {
  const copy = (text: string, label: string) => { clipboard.writeText(text); copied(label); };
  const items: MenuItemConstructorOptions[] = [];
  if (params.linkURL) {
    if (browserURL(params.linkURL)) items.push({ label: t('Open link in browser'), click: () => { void openBrowser(params.linkURL).catch(() => {}); } });
    items.push({ label: t('Copy link address'), click: () => copy(params.linkURL, 'Link address') });
  }
  if (items.length) items.push({ type: 'separator' });
  if (params.isEditable) {
    items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }, { role: 'selectAll' });
  } else {
    items.push({ label: t('Copy'), enabled: !!params.selectionText, click: () => copy(params.selectionText, 'Selected text') });
  }
  return items;
}
export function installContentActions(window: BrowserWindow, copied?: (label: string) => void) {
  window.webContents.on('context-menu', (_, params) => Menu.buildFromTemplate(contentMenuItems(params, copied)).popup({ window }));
  window.webContents.on('will-frame-navigate', (event) => {
    if (event.url === 'about:srcdoc' || event.url === 'about:blank') return;
    event.preventDefault();
    if (browserURL(event.url)) void openBrowser(event.url).catch(() => {});
  });
  // Email links are stripped of targets, but still handle an explicit new-window link safely.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (browserURL(url)) void openBrowser(url).catch(() => {});
    return { action: 'deny' };
  });
}

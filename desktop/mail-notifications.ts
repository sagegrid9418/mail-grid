import {t,nativeDirection,nativeLanguage} from './i18n';
import { BrowserWindow, nativeTheme, Notification, screen } from 'electron';

export type IncomingMail = { account: string; subject: string; from: string };
const escapeHTML = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export class MailNotifications {
  private popup: BrowserWindow | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private native = new Set<Notification>();
  constructor(private openInbox: (mail: IncomingMail) => void, private report: (message: string) => void, private testMode = false) {}
  show(mail: IncomingMail, kind: 'mail' | 'setup' = 'mail') {
    if (this.testMode) return;
    if (!Notification.isSupported()) { this.fallback(mail); return; }
    try {
      const notification = new Notification({ title: kind === 'setup' ? t('Mail Grid notifications') : t('New email in Mail Grid'), subtitle: mail.from.slice(0, 160), body: mail.subject.slice(0, 240), silent: false });
      notification.on('show', () => this.report(''));
      notification.on('click', () => this.openInbox(mail));
      notification.on('failed', (_, error: unknown) => { this.native.delete(notification); this.fallback(mail, typeof error === 'string' ? error : ''); });
      notification.on('close', () => this.native.delete(notification));
      this.native.add(notification);
      if (this.native.size > 5) { const oldest = this.native.values().next().value; oldest?.close(); if (oldest) this.native.delete(oldest); }
      notification.show();
    } catch { this.fallback(mail); }
  }
  private fallback(mail: IncomingMail, reason = '') {
    try { this.showPopup(mail, reason); } catch { this.report(t('Notifications are unavailable. New mail still appears in Mail Grid.')); }
  }
  private showPopup(mail: IncomingMail, reason = '') {
    this.report(t('System notifications are unavailable. Use Enable / test notifications to request permission, then allow Mail Grid in system notification settings. Desktop pop-ups are being used.')+(reason?' '+reason.slice(0,240):''));
    this.closePopup();
    const area = screen.getPrimaryDisplay().workArea;
    const popup = new BrowserWindow({
      width: 370, height: 166, x: area.x + Math.max(0, area.width - 386), y: area.y + Math.max(0, area.height - 182),
      frame: false, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    this.popup = popup;
    if (process.platform !== 'win32') popup.setVisibleOnAllWorkspaces(true);
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popup.webContents.on('will-navigate', (event) => {
      event.preventDefault();
      try { if (new URL(event.url).hostname === 'open') this.openInbox(mail); } catch { /* Ignore invalid popup links. */ }
      this.closePopup();
    });
    popup.once('ready-to-show', () => { if (!popup.isDestroyed()) popup.showInactive(); });
    popup.on('closed', () => { if (this.popup === popup) this.popup = null; });
    const dark = nativeTheme.shouldUseDarkColors;
    const html = `<!doctype html><html lang="${nativeLanguage()}" dir="${nativeDirection()}"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:13px system-ui;margin:0;padding:18px 20px;color:${dark ? '#dbe4f2' : '#243249'};background:${dark ? '#192334' : '#fff'};border:1px solid #dce3f0;border-radius:10px}header{display:flex;justify-content:space-between;font-size:11px;color:#637b9c}a{color:${dark ? '#a5bdff' : '#3150c9'};text-decoration:none}strong{display:block;margin:12px 0 4px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}p{margin:0 0 14px;color:#7d8ba0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style></head><body><header>MAIL GRID · ${escapeHTML(t('New email'))}<a href="mailgrid-notification://close" aria-label="${escapeHTML(t('Dismiss new email notification'))}">✕</a></header><strong>${escapeHTML(mail.subject.slice(0,240))}</strong><p>${escapeHTML(mail.from.slice(0,160))}</p><a href="mailgrid-notification://open">${escapeHTML(t('Open inbox →'))}</a></body></html>`;
    void popup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => this.closePopup());
    this.timer = setTimeout(() => this.closePopup(), 10000);
  }
  private closePopup() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.popup && !this.popup.isDestroyed()) this.popup.destroy();
    this.popup = null;
  }
  close() { this.closePopup(); for (const notification of this.native) notification.close(); this.native.clear(); }
}

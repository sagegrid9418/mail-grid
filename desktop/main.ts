import {languageSupported} from './language-support';
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, Tray } from 'electron';
import os from 'node:os';
import {initializeProfile,readPreferences,savePreferences,validateSetup,setupDefaults,type DesktopPreferences} from './preferences';
import {loadNativeLanguage,t} from './i18n';
import {acknowledgeMacUpdate,finishMacRecovery} from './mac-update-adapter';
import { Updates } from './updates';
import { ReleaseSource, RELEASE_ORIGIN, type UpdatePreference } from './releases';
import { createUpdateAdapter } from './update-provider';
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { showUnreadBadge } from './unread-badge';
import { openSystemSettings } from './system-settings';
import { installContentActions, openBrowser } from './content-actions';
import { MailNotifications, type IncomingMail } from './mail-notifications';
import { forgetCredential, getCredential, rememberCredential } from './credentials';

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let engine: ChildProcessWithoutNullStreams | null = null;
let running = false;
let stopping = false;
let isQuitting = false;
let nextId = 1;
const pending = new Map<number, Pending>();
type StartupState = { requested: boolean; enabled: boolean; error: string; status?: string };
let startupState: StartupState = { requested: false, enabled: false, error: '' };
let notificationStatus = '';
let activePorts: AppSettings['ports'] | null = null;
let updateReady = false;
let updates: Updates;
const portsMatch = (a: AppSettings['ports'] | null, b: AppSettings['ports']) => !!a && a.smtp === b.smtp && a.imap === b.imap && a.pop3 === b.pop3;
const mailNotifications = new MailNotifications((mail) => {
  if (window?.isMinimized()) window.restore();
  window?.show(); window?.focus(); sendEvent('notification_open', mail);
}, (message) => { notificationStatus = message; sendEvent('notification_status', { message }); }, process.argv.includes('--test-mode'));
let serviceError = 'The local mail engine is starting.';
if (process.env.MAILGRID_DATA_DIR) app.setPath('userData', path.resolve(process.env.MAILGRID_DATA_DIR));
const allowed = new Set(['status', 'accounts.list', 'accounts.create', 'accounts.delete', 'accounts.resetPassword', 'accounts.updatePassword', 'accounts.verifyPassword', 'accounts.credentials', 'folders.list', 'messages.list', 'messages.get', 'messages.delete', 'messages.update', 'messages.markRead', 'messages.attachment', 'compose.send', 'settings.get', 'settings.update', 'messages.unreadCounts', 'sidebar.get', 'sidebar.update']);
type AppSettings = { ports: { smtp: number; imap: number; pop3: number }; retentionDays: number; startAtLogin: boolean; notificationsEnabled: boolean; theme: 'system' | 'light' | 'dark' };
const defaultSettings: AppSettings = { ports: { smtp: 1025, imap: 1143, pop3: 1110 }, retentionDays: 0, startAtLogin: true, notificationsEnabled: true, theme: 'system' };

function readDesktopPreferences():DesktopPreferences {return readPreferences(app.getPath('userData'));}
function saveDesktopPreferences(value:DesktopPreferences){savePreferences(app.getPath('userData'),value);}
let servicesActivation:Promise<void>|undefined;
const localeDirectory=()=>path.join(app.getAppPath(),'assets/locales');
const availableLanguages=()=>({has:(locale:string)=>languageSupported(locale,JSON.parse(readFileSync(path.join(localeDirectory(),'supported.json'),'utf8')).catalogs)});
function desktopTheme(): AppSettings['theme'] {
  try { const prefs=readDesktopPreferences();const value=prefs.theme||prefs.setupDraft?.theme; return value && ['system', 'light', 'dark'].includes(value) ? value : 'system'; } catch { return 'system'; }
}
function storedSettings(): AppSettings {
  try {
    const value = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
    return { ...defaultSettings, ...value, ports: { ...defaultSettings.ports, ...value.ports }, theme: desktopTheme() };
  } catch { return { ...defaultSettings, ports: { ...defaultSettings.ports }, theme: desktopTheme() }; }
}

function validateSettings(value: AppSettings) {
  const ports = [value?.ports?.smtp, value?.ports?.imap, value?.ports?.pop3];
  if (ports.some((port) => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== 3) throw new Error('Choose three different ports between 1024 and 65535.');
  if (!Number.isInteger(value.retentionDays) || value.retentionDays < 0 || value.retentionDays > 3650) throw new Error('Retention must be between 0 and 3650 days.');
  if (typeof value.notificationsEnabled !== 'boolean') throw new Error('Invalid notification setting.');
  if (!['system', 'light', 'dark'].includes(value.theme)) throw new Error('Choose System, Light, or Dark appearance.');
  if (typeof value.startAtLogin !== 'boolean') throw new Error('Invalid login startup setting.');
}

async function desktopRequest(method: string, params: unknown) {
  if(method==='updates.confirmStartup'){if(process.platform==='darwin'&&readDesktopPreferences().onboarding?.completed){await servicesActivation;await acknowledgeMacUpdate();await finishMacRecovery()}return {ok:true}}
  if(method==='onboarding.get'){
    const prefs=readDesktopPreferences();return {completed:prefs.onboarding?.completed===true,migrationNotice:prefs.languageMigrationNotice===true,choices:prefs.onboarding?.completed?{...setupDefaults,...(prefs.language?{language:prefs.language}:{}),...(prefs.theme?{theme:prefs.theme}:{}),...(prefs.updates||{})}:{...setupDefaults,...prefs.setupDraft}};
  }
  if(method==='onboarding.draft'){
    const prefs=readDesktopPreferences();if(prefs.onboarding?.completed)throw Error('Setup is already complete.');const draft=validateSetup(params,availableLanguages());saveDesktopPreferences({...prefs,setupDraft:draft});return {ok:true};
  }
  if(method==='onboarding.complete'){
    const value=validateSetup(params,availableLanguages()),prefs=readDesktopPreferences();
    if(prefs.onboarding?.completed)return {ok:true};
    saveDesktopPreferences({...prefs,language:value.language,languageMigrationNotice:false,theme:value.theme,updates:{preference:value.preference,automaticChecks:value.automaticChecks},onboarding:{completed:true,version:1},setupDraft:undefined});
    loadNativeLanguage(localeDirectory(),value.language);nativeTheme.themeSource=value.theme;updates.preferences({preference:value.preference,automaticChecks:value.automaticChecks});
    await activateServices();return {ok:true};
  }
  if(method==='language.get'){const prefs=readDesktopPreferences();return {language:prefs.language||'en',migrationNotice:prefs.languageMigrationNotice===true}}
  if(method==='language.set'){
    const language=(params as {language?:string})?.language;if(!language||!availableLanguages().has(language))throw Error('Choose a valid interface language.');
    saveDesktopPreferences({...readDesktopPreferences(),language,languageMigrationNotice:false});loadNativeLanguage(localeDirectory(),language);if(tray)createTrayMenu();return {language};
  }
  if(!readDesktopPreferences().onboarding?.completed && !['updates.get','status','settings.get','sidebar.get'].includes(method))throw Error('Finish setup before using Mail Grid.');

  if (method === 'updates.get') return updates.state;
  if (method === 'updates.check') return updates.check();
  if (method === 'updates.download'||method==='updates.resume') {void updates.download().catch(error=>console.error('Update download:',error));return updates.state;}
  if(method==='updates.pause')return updates.pause();
  if (method === 'updates.cancel') return updates.cancel();
  if (method === 'updates.preferences') return updates.preferences(params as { preference: UpdatePreference; automaticChecks: boolean });
  if (method === 'updates.install') return updates.install();
  if (!allowed.has(method)) throw new Error('Unsupported request.');
  if (method === 'status') { refreshStartupState(); return { running, ports: activePorts || storedSettings().ports, configuredPorts: storedSettings().ports, restartPending: !portsMatch(activePorts, storedSettings().ports), updateReady, dataDir: app.getPath('userData'), error: serviceError, startup: startupState, notificationStatus }; }
  if (method === 'sidebar.get') return { expandedAccounts: readDesktopPreferences().expandedAccounts || {} };
  if (method === 'sidebar.update') {
    const value = params as { address?: unknown; expanded?: unknown };
    if (typeof value?.address !== 'string' || value.address.length > 254 || !value.address.includes('@') || typeof value.expanded !== 'boolean') throw new Error('Invalid account expansion setting.');
    const preferences = readDesktopPreferences();
    saveDesktopPreferences({ ...preferences, expandedAccounts: { ...preferences.expandedAccounts, [value.address]: value.expanded } });
    return { ok: true };
  }
  if (method === 'messages.unreadCounts') return refreshUnread();
  if (method === 'settings.get') return storedSettings();
  if (method === 'accounts.credentials') {
    const address = (params as { address?: unknown })?.address;
    if (typeof address !== 'string') throw new Error('Choose an account.');
    return getCredential(address);
  }
  if (method === 'settings.update') {
    const value = params as AppSettings;
    validateSettings(value);
    let result: unknown;
    if (running) result = await request(method, value);
    else {
      const file = path.join(app.getPath('userData'), 'settings.json');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
      renameSync(file + '.tmp', file);
      result = { settings: value, restartRequired: true };
    }
    saveDesktopPreferences({ ...readDesktopPreferences(), theme: value.theme });
    nativeTheme.themeSource = value.theme;
    window?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#111827' : '#f7f8fa');
    configureStartup(value.startAtLogin);
    if (!value.notificationsEnabled) mailNotifications.close();
    return { ...(result as object), restartRequired: !running || !portsMatch(activePorts, value.ports), startup: startupState };
  }
  const result = await request(method, params);
  const input = params as { address: string; password?: string };
  if (method === 'accounts.create' || method === 'accounts.updatePassword' || method === 'accounts.resetPassword') {
    const value = result as { address?: string; password: string };
    await rememberCredential(value.address || input.address, value.password);
  }
  if (method === 'accounts.verifyPassword') await rememberCredential(input.address, input.password!);
  if (method === 'accounts.delete') {
    forgetCredential(input.address);
    const preferences = readDesktopPreferences(), expandedAccounts = { ...preferences.expandedAccounts };
    delete expandedAccounts[input.address];
    saveDesktopPreferences({ ...preferences, expandedAccounts });
  }
  if (method === 'accounts.create' || method === 'accounts.delete') sendEvent('accounts_changed', {});
  if (['accounts.create', 'accounts.delete', 'compose.send', 'messages.update', 'messages.delete', 'messages.markRead', 'settings.update'].includes(method)) scheduleUnread();
  return result;
}

const sendEvent = (event: string, data: unknown) => window?.webContents.send('mailgrid:event', event, data);
const engineName = process.platform === 'win32' ? 'mailgrid-engine.exe' : 'mailgrid-engine';
const enginePath = () => app.isPackaged
  ? path.join(process.resourcesPath, engineName)
  : path.join(app.getAppPath(), 'engine', 'bin', engineName);

function failPending(error: Error) {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
}

function request(method: string, params: unknown = {}): Promise<unknown> {
  if (!engine || !running || !engine.stdin.writable) return Promise.reject(new Error(serviceError));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Mail engine did not respond.')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    engine!.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
      if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  });
}

type UnreadCounts = { total: number; accounts: Record<string, { total: number; folders: Record<string, number> }> };
let unreadTimer: NodeJS.Timeout | null = null;
let unreadRefresh: Promise<UnreadCounts> | null = null;
let unreadDirty = false;
function refreshUnread(): Promise<UnreadCounts> {
  if (unreadRefresh) { unreadDirty = true; return unreadRefresh; }
  unreadRefresh = request('messages.unreadCounts').then(value => {
    const counts = value as UnreadCounts;
    try { showUnreadBadge(counts.total, window, tray); } catch (error) { console.warn('Unread badge unavailable:', error); }
    sendEvent('unread_counts', counts);
    return counts;
  }).finally(() => { unreadRefresh = null; if (unreadDirty) { unreadDirty = false; scheduleUnread(); } });
  return unreadRefresh;
}
function scheduleUnread() {
  if (unreadTimer || isQuitting) return;
  unreadTimer = setTimeout(() => { unreadTimer = null; if (running) void refreshUnread().catch(() => {}); }, 80);
}

async function startEngine(): Promise<void> {
  if (engine) return;
  const binary = enginePath();
  if (!existsSync(binary)) {
    serviceError = `Mail engine is missing: ${binary}. Run npm run build:engine.`;
    sendEvent('service_error', { message: serviceError });
    throw new Error(serviceError);
  }
  running = false;
  serviceError = 'The local mail engine is starting.';
  const child = spawn(binary, ['--data-dir', app.getPath('userData')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  engine = child;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const startupTimer = setTimeout(() => { serviceError = 'Mail engine startup timed out.'; child.kill(); rejectReady(new Error(serviceError)); }, 15000);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    try {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: string; event?: string; data?: unknown };
      if (message.event) {
        if (message.event === 'ready') { scheduleUnread(); activePorts = (message.data as { ports: AppSettings['ports'] }).ports; running = true; serviceError = ''; clearTimeout(startupTimer); resolveReady(); }
        if (message.event === 'service_error') serviceError = String((message.data as { message?: string })?.message || 'Mail engine failed.');
        if (message.event === 'message_received' && storedSettings().notificationsEnabled) {
          const data = message.data as IncomingMail;
          if (data && typeof data.subject === 'string' && typeof data.from === 'string' && typeof data.account === 'string') mailNotifications.show(data);
        }
        if (message.event === 'message_received' || message.event === 'mailbox_changed') scheduleUnread();
        sendEvent(message.event, message.data);
        return;
      }
      if (typeof message.id !== 'number') return;
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error)); else item.resolve(message.result);
    } catch { /* Invalid engine output is ignored. */ }
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); stderr = stderr.slice(-4000); });
  child.on('error', (error) => { clearTimeout(startupTimer); rejectReady(error); if (engine === child) engine = null; running = false; failPending(error); serviceError = error.message; sendEvent('service_error', { message: serviceError }); });
  child.on('exit', (code) => {
    clearTimeout(startupTimer);
    if (engine !== child) return;
    engine = null;
    running = false;
    failPending(new Error('Mail engine stopped.'));
    if (!stopping && !isQuitting) {
      serviceError = stderr.trim().split('\n').at(-1) || `Mail engine exited (${code ?? 'unknown'}).`;
      sendEvent('service_error', { message: serviceError });
    }
    rejectReady(new Error(serviceError || 'Mail engine stopped.'));
  });
  return ready;
}

async function stopEngine() {
  if (!engine) return;
  stopping = true;
  const child = engine;
  if (running) {
    try { await Promise.race([request('shutdown'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))]); }
    catch { child.kill(); }
  } else child.kill();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null || engine !== child) return resolve();
    child.once('exit', () => resolve());
    setTimeout(() => { if (child.exitCode === null) child.kill(); resolve(); }, 2500);
  });
  stopping = false;
}

function loginItemOptions(): Electron.LoginItemSettingsOptions {
  if (process.platform === 'darwin') return { type: 'mainAppService' };
  const stub = path.resolve(path.dirname(process.execPath), '..', path.basename(process.execPath));
  return { args: ['--hidden'], ...(existsSync(stub) ? { path: stub } : {}) };
}
function refreshStartupState() {
  if (process.argv.includes('--test-mode') || !app.isPackaged || process.platform === 'linux') return;
  try {
    const actual = app.getLoginItemSettings(loginItemOptions());
    startupState.status = actual.status;
    startupState.enabled = actual.openAtLogin && (process.platform !== 'win32' || actual.executableWillLaunchAtLogin !== false);
    startupState.error = actual.status === 'requires-approval'
      ? t('Mail Grid is registered. Allow it in System Settings → General → Login Items.')
      : startupState.enabled !== startupState.requested
        ? t('The system did not apply the startup setting. Enable Mail Grid in system startup settings.') : '';
  } catch (error) { startupState.error = String(error); }
}

function configureStartup(enabled: boolean) {
  startupState = { requested: enabled, enabled: false, error: '' };
  if (process.argv.includes('--test-mode')) { startupState.enabled = enabled; return; }
  if (!app.isPackaged) { startupState.error = enabled ? t('Startup is available in the installed app.') : ''; return; }
  try {
  if (process.platform === 'linux') {
    const dir = path.join(app.getPath('home'), '.config', 'autostart');
    const file = path.join(dir, 'mail-grid.desktop');
    if (!enabled) { if (existsSync(file)) unlinkSync(file); return; }
    mkdirSync(dir, { recursive: true });
    const launcher = process.env.APPIMAGE && path.isAbsolute(process.env.APPIMAGE) ? process.env.APPIMAGE : process.execPath;
    const executable = launcher.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Mail Grid\nExec="${executable}" --hidden\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o644 });
  } else {
    app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions() });
    refreshStartupState();
  }
  if (process.platform === 'linux') startupState.enabled = enabled;
  } catch (error) { startupState.error = String(error); }
}

function handleWindowsInstaller() {
  if (process.platform !== 'win32') return false;
  const event = process.argv.find((arg) => ['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete'].includes(arg));
  if (!event) return false;
  if (event === '--squirrel-obsolete') { app.exit(0); return true; }
  const update = path.resolve(path.dirname(process.execPath), '..', 'Update.exe');
  app.whenReady().then(() => {
    if (event === '--squirrel-uninstall') configureStartup(false);
    const task = spawn(update, [event === '--squirrel-uninstall' ? '--removeShortcut' : '--createShortcut', path.basename(process.execPath)], { windowsHide: true, stdio: 'ignore' });
    task.once('close', () => app.exit(0));
    task.once('error', () => app.exit(1));
    setTimeout(() => app.exit(0), 10000);
  });
  return true;
}

function createWindow() {
  window = new BrowserWindow({
    width: 1320, height: 830, minWidth: 980, minHeight: 620,
    title: 'Mail Grid', backgroundColor: nativeTheme.shouldUseDarkColors ? '#111827' : '#f7f8fa', show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  installContentActions(window, label => sendEvent('clipboard_copied', { label }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('close', (event) => { if (!readDesktopPreferences().onboarding?.completed) { isQuitting=true;app.quit();return; } if (!isQuitting) { event.preventDefault(); window?.hide(); } });
  window.on('focus', () => { refreshStartupState(); sendEvent('startup_status', startupState); });
  window.on('ready-to-show', () => {
    const atLogin = process.platform === 'darwin' && !process.argv.includes('--test-mode') && app.getLoginItemSettings({ type: 'mainAppService' }).wasOpenedAtLogin;
    if (!process.argv.includes('--hidden') && !atLogin) window?.show();
  });
  if (!app.isPackaged && !process.argv.includes('--preview')) window.loadURL('http://127.0.0.1:5173');
  else window.loadFile(path.join(__dirname, '..', 'dist-ui', 'index.html'));
}

function createTray() {
  const iconPath = path.join(app.getAppPath(), 'assets', 'tray.png');
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 18, height: 18 }));
  tray.setToolTip('Mail Grid');
  createTrayMenu();
  tray.on('double-click', () => window?.show());
  tray.on('click', () => window?.show());
}
function createTrayMenu(){
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: t('Open Mail Grid'), click: () => window?.show() },
    { type: 'separator' },
    { label: t('Quit'), click: () => app.quit() },
  ]));
}

function activateServices():Promise<void>{
  if(servicesActivation)return servicesActivation;
  servicesActivation=(async()=>{
    if (!process.argv.includes('--test-mode'))createTray();
    if(!process.argv.includes('--test-mode')||process.env.MAILGRID_UPDATE_TEST_ORIGIN)updates.start();
    try { configureStartup(storedSettings().startAtLogin); } catch (error) { console.error('Login startup:', error); }
    try { await startEngine(); } catch (error) { console.error('Mail engine:', error); }
    // A first native request registers the installed app with macOS Notifications.
    if (process.platform === 'darwin' && app.isPackaged && !process.argv.includes('--test-mode') && storedSettings().notificationsEnabled && !readDesktopPreferences().notificationsRequested) {
      saveDesktopPreferences({ ...readDesktopPreferences(), notificationsRequested: true });
      mailNotifications.show({ account: 'catchall', from: 'Mail Grid', subject: t('Allow alerts, sounds, and unread badges for your local mail.') }, 'setup');
    }
  })();return servicesActivation;
}

if (handleWindowsInstaller()) { /* Squirrel owns this short-lived invocation. */ }
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => window?.show());
  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.mailgrid.app');
    if (process.platform === 'linux') app.setDesktopName('mail-grid.desktop');
    setInterval(scheduleUnread, 30000).unref();
    initializeProfile(app.getPath('userData'));
    const localePrefs=readDesktopPreferences();if(localePrefs.language&&!availableLanguages().has(localePrefs.language))saveDesktopPreferences({...localePrefs,language:'en',languageMigrationNotice:true});
    if(!localePrefs.onboarding?.completed&&localePrefs.setupDraft&&!availableLanguages().has(localePrefs.setupDraft.language))saveDesktopPreferences({...readDesktopPreferences(),languageMigrationNotice:true,setupDraft:{...localePrefs.setupDraft,language:'en'}});
    loadNativeLanguage(localeDirectory(),readDesktopPreferences().language||'en');
    nativeTheme.themeSource = desktopTheme();
    const localTest = !app.isPackaged && process.env.MAILGRID_UPDATE_TEST_ORIGIN;
    const updateOrigin = localTest || RELEASE_ORIGIN;
    if (localTest && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(localTest)) throw new Error('Local update testing requires a loopback origin.');
    const trustPath = localTest && process.env.MAILGRID_UPDATE_TEST_TRUST ? process.env.MAILGRID_UPDATE_TEST_TRUST : path.join(app.getAppPath(), 'assets/update-trust.json');
    let publicKeys: string[] = [];
    try { const keys = JSON.parse(readFileSync(trustPath, 'utf8')).publicKeys; publicKeys = Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : []; } catch { /* A build without trust keys never downloads updates. */ }
    const packageType = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'nsis' : process.env.APPIMAGE ? 'appimage' : existsSync(path.join(process.resourcesPath, 'package-type')) && readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8').trim() === 'deb' ? 'deb' : 'unsupported';
    const source = new ReleaseSource({ origin: updateOrigin, keys: publicKeys, platform: process.platform, arch: process.arch, packageType, systemVersion: process.getSystemVersion?.() || os.release() });
    const localUpdateConfig = localTest ? path.join(app.getPath('userData'), 'local-update-config.yml') : undefined;
    if (localUpdateConfig) { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(localUpdateConfig, JSON.stringify({ updaterCacheDirName: 'MailGrid-local-update-tests' }), { mode: 0o600 }); }
    updates = new Updates({ version: app.getVersion(), source, adapter: createUpdateAdapter(source, app.getVersion(), localUpdateConfig), supported: !!publicKeys.length && packageType !== 'unsupported' && (!!localTest || app.isPackaged), unsupportedReason: !publicKeys.length ? 'Update service is not configured for this installation. Install the latest Mail Grid installer.' : !app.isPackaged && !localTest ? 'Run the installed Mail Grid app to check for updates.' : 'This installation format does not support updates. Install the supported package for your system.', preferences: readDesktopPreferences().updates || {}, persist: value => saveDesktopPreferences({ ...readDesktopPreferences(), updates: value }), emit: value => { updateReady = value.phase === 'ready'; sendEvent('update_status', value); }, stopEngine: async () => {
      if (!engine) return;
      const child = engine; stopping = true;
      try {
        await request('shutdown');
        await new Promise<void>((resolve, reject) => {
          if (child.exitCode !== null || engine !== child) return resolve();
          const done = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { child.removeListener('exit', done); reject(new Error('The mail service has not stopped safely. Installation was cancelled.')); }, 10000);
          child.once('exit', done);
        });
        isQuitting = true; mailNotifications.close();
      } finally { stopping = false; }
    }, recoverEngine: async () => { isQuitting = false; if (!engine) await startEngine(); } });

    const validateSender = (event: Electron.IpcMainInvokeEvent) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Untrusted request.');
    };
    ipcMain.handle('mailgrid:request', (event, method: string, params: unknown) => { validateSender(event); return desktopRequest(method, params); });
    ipcMain.handle('mailgrid:restart', async (event) => { validateSender(event);if(!readDesktopPreferences().onboarding?.completed)throw Error('Finish setup before using Mail Grid.'); await stopEngine(); await startEngine(); return { running }; });
    ipcMain.handle('mailgrid:openExternal', (event, url: unknown) => { validateSender(event); return openBrowser(url); });
    ipcMain.handle('mailgrid:systemSettings', (event, kind: unknown) => { validateSender(event); return openSystemSettings(kind); });
    ipcMain.handle('mailgrid:testNotification', (event) => {
      validateSender(event);
      if(!readDesktopPreferences().onboarding?.completed)throw Error('Finish setup before using Mail Grid.');
      const mail = { account: 'catchall', from: 'Mail Grid', subject: t('Notifications are working') };
      if (!storedSettings().notificationsEnabled) throw new Error('Enable and save notifications first.');
      mailNotifications.show(mail); sendEvent('notification_test', mail);
    });
    ipcMain.handle('mailgrid:relaunch', async (event) => {
      validateSender(event);
      await stopEngine();
      setImmediate(() => { isQuitting = true; mailNotifications.close(); app.relaunch(); app.quit(); });
    });
    ipcMain.handle('mailgrid:copy', (event, value: string, label?: unknown) => { validateSender(event); clipboard.writeText(String(value).slice(0, 1048576)); const copiedLabel = typeof label === 'string' ? label.trim().slice(0, 80) : ''; sendEvent('clipboard_copied', { label: copiedLabel || 'Content' }); return true; });
    createWindow();
    if (readDesktopPreferences().onboarding?.completed) await activateServices();

  });
  app.on('before-quit', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    isQuitting = true;
    mailNotifications.close();
    Promise.all([updates?.close(),stopEngine()]).finally(() => app.quit());
  });
}

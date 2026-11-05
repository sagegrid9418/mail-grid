import { t as translate, currentLanguage, number, plural } from './i18n';
import { errorMessage } from './errors';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LinkedText, messagePreviewHTML } from './EmailContent';
import { ArrowDownToLine, ArrowLeft, Check, ChevronDown, CircleHelp, Copy, FileText, Folder, Inbox, Mail, MailPlus, Plus, RefreshCw, Search, Send, Settings2, ShieldCheck, Trash2, X, Undo2, Bell, MailOpen, } from 'lucide-react';
import { AccountTree, UnreadCount } from './AccountTree';
import { SettingsPanel, RestartPrompt } from './SettingsPanel';
import { UpdatesPanel } from './UpdatesPanel';
import type { UpdateSnapshot } from '../desktop/updates';
import { AccountManager, ChangePassword, ConnectionSettings } from './AccountTools';
import type { Account, Attachment, MessageDetail, MessageSummary, Settings, Status, SidebarState, UnreadCounts } from './types';
type Modal = 'account' | 'compose' | 'settings' | 'connection' | 'password' | 'accounts' | 'changePassword' | null;
type ViewTab = 'html' | 'text' | 'headers' | 'raw';
const request = <T,>(method: string, params?: unknown) => window.mailgrid.request<T>(method, params);
const dateLabel = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    return date.toDateString() === now.toDateString()
        ? date.toLocaleTimeString(currentLanguage(), { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString(currentLanguage(), { month: 'short', day: 'numeric' });
};
const formatSize = (size: number) => size < 1024 ? `${number(size)} B` : size < 1048576 ? `${number(Math.round(size / 1024))} KB` : `${new Intl.NumberFormat(currentLanguage(),{maximumFractionDigits:1}).format(size/1048576)} MB`;
function App() {
    const [status, setStatus] = useState<Status | null>(null);
    const [error, setError] = useState('');
    const [accounts, setAccounts] = useState<Account[]>([]);
    const [selected, setSelected] = useState('catchall');
    const [folder, setFolder] = useState('INBOX');
    const [folderRevision, setFolderRevision] = useState(0);
    const [expandedAccounts, setExpandedAccounts] = useState<Record<string, boolean>>({});
    const expandedRef = useRef<Record<string, boolean>>({});
    const [sidebarReady, setSidebarReady] = useState(false);
    const [unread, setUnread] = useState<UnreadCounts>({ total: 0, accounts: {} });
    const handleTreeError = useCallback((cause: unknown) => setError(errorMessage(cause)), []);
    const [messages, setMessages] = useState<MessageSummary[]>([]);
    const [activeUID, setActiveUID] = useState<number | null>(null);
    const [detail, setDetail] = useState<MessageDetail | null>(null);
    const [checkedUIDs, setCheckedUIDs] = useState<Set<number>>(new Set());
    const [allMatching, setAllMatching] = useState(false);
    const [actionBusy, setActionBusy] = useState(false);
    const [incoming, setIncoming] = useState<{
        account: string;
        from: string;
        subject: string;
    } | null>(null);
    const incomingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const listPanel = useRef<HTMLElement | null>(null);
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState(false);
    const [modal, setModal] = useState<Modal>(null);
    const [tab, setTab] = useState<ViewTab>('html');
    const [newAddress, setNewAddress] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [connectionAddress, setConnectionAddress] = useState('');
    const [editingAccount, setEditingAccount] = useState('');
    const [revealed, setRevealed] = useState<{
        address: string;
        password: string;
    } | null>(null);
    const [composeFrom, setComposeFrom] = useState('');
    const [composeTo, setComposeTo] = useState('');
    const [composeSubject, setComposeSubject] = useState('');
    const [composeText, setComposeText] = useState('');
    const [settings, setSettings] = useState<Settings>({ ports: { smtp: 1025, imap: 1143, pop3: 1110 }, retentionDays: 0, startAtLogin: true, notificationsEnabled: true, theme: 'system' });
    const [notificationsEnabled, setNotificationsEnabled] = useState(true);
    const [notice, setNotice] = useState('');
    const [copied, setCopied] = useState('');
    const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [savedTheme, setSavedTheme] = useState<Settings['theme']>('system');
    const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
    const [restartTarget, setRestartTarget] = useState<'service' | 'app' | null>(null);
    const [appRestartPending, setAppRestartPending] = useState(false);
    const [updates, setUpdates] = useState<UpdateSnapshot | null>(null);
    const [showUpdates, setShowUpdates] = useState(false);
    const themeChoice = modal === 'settings' ? settings.theme : savedTheme;
    const dark = themeChoice === 'dark' || (themeChoice === 'system' && systemDark);
    const previewHTML = useMemo(() => detail ? messagePreviewHTML(detail.html, detail.text, dark) : null, [detail, dark]);
    useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemDark(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
    useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; }, [dark]);
    useEffect(() => () => {
        if (copyTimer.current)
            clearTimeout(copyTimer.current);
    }, []);
    const listRequest = useRef(0);
    const currentView = useRef({ account: selected, folder, query });
    currentView.current = { account: selected, folder, query };
    const selectedAccount = selected === 'catchall' ? translate('Catch-all inbox') : selected;
    const serviceReady = status?.running === true;
    const refreshFolders = useCallback(async () => { setFolderRevision(value => value + 1); }, []);
    const saveExpansion = (address: string, expanded: boolean) => {
        if (expandedRef.current[address] === expanded)
            return;
        expandedRef.current = { ...expandedRef.current, [address]: expanded };
        setExpandedAccounts(expandedRef.current);
        void request('sidebar.update', { address, expanded }).catch(handleTreeError);
    };
    const refreshAccounts = useCallback(async () => {
        try {
            const items = await request<Account[]>('accounts.list');
            setAccounts(items);
            setComposeFrom((current) => items.some((item) => item.address === current) ? current : items[0]?.address || '');
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
    }, []);
    const refreshMessages = useCallback(async () => {
        if (!serviceReady)
            return;
        const matchesView = () => currentView.current.account === selected && currentView.current.folder === folder && currentView.current.query === query;
        if (!matchesView())
            return;
        const sequence = ++listRequest.current;
        setBusy(true);
        try {
            const items = await request<MessageSummary[]>('messages.list', { account: selected, folder, query, limit: 500 });
            if (sequence !== listRequest.current || !matchesView())
                return;
            setMessages(items);
            setCheckedUIDs((current) => new Set([...current].filter((uid) => items.some((item) => item.uid === uid))));
            setActiveUID((uid) => items.some((item) => item.uid === uid) ? uid : null);
            setError('');
        }
        catch (cause) {
            if (sequence === listRequest.current && matchesView()) {
                setError(errorMessage(cause));
                setMessages([]);
            }
        }
        finally {
            if (sequence === listRequest.current)
                setBusy(false);
        }
    }, [selected, folder, query, serviceReady]);
    useEffect(() => {
        const unsubscribe = window.mailgrid.onEvent((event, data) => {
            if (event === 'update_status')
                setUpdates(data as UpdateSnapshot);
            if (event === 'startup_status')
                setStatus(current => current ? { ...current, startup: data as Status['startup'] } : current);
            if (event === 'unread_counts')
                setUnread(data as UnreadCounts);
            if (event === 'accounts_changed')
                refreshAccounts();
            if (event === 'clipboard_copied') {
                const label = (data as {
                    label?: string;
                })?.label || 'Content';
                setCopied(translate('{label} copied to clipboard', { label: translate(label) }));
                if (copyTimer.current)
                    clearTimeout(copyTimer.current);
                copyTimer.current = setTimeout(() => setCopied(''), 3000);
            }
            if (event === 'restart_required') {
                setStatus(current => current ? { ...current, updateReady: true } : current);
                setAppRestartPending(true);
                setRestartTarget('app');
            }
            if (event === 'ready') {
                request<Status>('status').then(setStatus).catch((cause) => setError(errorMessage(cause)));
                refreshAccounts();
                request<UnreadCounts>('messages.unreadCounts').then(setUnread).catch(handleTreeError);
            }
            if (event === 'service_error') {
                setStatus(null);
                setError(String((data as {
                    message?: string;
                })?.message || 'Mail engine unavailable'));
            }
            if (event === 'notification_open') {
                const mail = data as {
                    account: string;
                };
                chooseMailbox(mail.account || 'catchall');
            }
            if ((event === 'message_received' || event === 'notification_test') && notificationsEnabled) {
                setIncoming(data as {
                    account: string;
                    from: string;
                    subject: string;
                });
                if (incomingTimer.current)
                    clearTimeout(incomingTimer.current);
                incomingTimer.current = setTimeout(() => setIncoming(null), 10000);
            }
            if (event === 'notification_status')
                setStatus((current) => current ? { ...current, notificationStatus: (data as {
                        message: string;
                    }).message } : current);
            if (event === 'message_received' || event === 'mailbox_changed') {
                refreshMessages();
                refreshFolders();
            }
        });
        return unsubscribe;
    }, [refreshAccounts, refreshMessages, refreshFolders, notificationsEnabled]);
    useEffect(() => { refreshFolders(); }, [refreshFolders]);
    useEffect(() => {
        if (!notificationsEnabled) {
            setIncoming(null);
            if (incomingTimer.current)
                clearTimeout(incomingTimer.current);
        }
    }, [notificationsEnabled]);
    useEffect(() => () => {
        if (incomingTimer.current)
            clearTimeout(incomingTimer.current);
    }, []);
    useEffect(() => {
        request<UpdateSnapshot>('updates.get').then(setUpdates).catch(handleTreeError);
        request<{migrationNotice?:boolean}>('language.get').then(value=>{if(value.migrationNotice)setNotice(translate('Your previous language is not available as a complete offline translation. English is selected. Choose a language in Settings.'))}).catch(handleTreeError);
        request<SidebarState>('sidebar.get').then(value => { expandedRef.current = value.expandedAccounts; setExpandedAccounts(value.expandedAccounts); setSidebarReady(true); }).catch(cause => { handleTreeError(cause); setSidebarReady(true); });
        request<Settings>('settings.get').then((value) => { setSettings(value); setSavedTheme(value.theme); setNotificationsEnabled(value.notificationsEnabled); }).catch((cause) => setError(errorMessage(cause)));
        request<Status>('status').then((value) => {
            setStatus(value);
            if (value.running) {
                refreshAccounts();
                request<UnreadCounts>('messages.unreadCounts').then(setUnread).catch(handleTreeError);
            }
            else if (value.error)
                setError(value.error);
        }).catch((cause) => setError(errorMessage(cause)));
    }, []);
    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (!(event.metaKey || event.ctrlKey))
                return;
            const target = event.target as HTMLElement;
            if (event.key.toLowerCase() === 'a' && !target.closest('input,textarea,[contenteditable="true"]')) {
                event.preventDefault();
                const content = target.closest('.preview-body,.env-config,.credential-box,.connection-credentials');
                if (content) {
                    const range = document.createRange();
                    range.selectNodeContents(content);
                    const selection = getSelection();
                    selection?.removeAllRanges();
                    selection?.addRange(range);
                }
            }
            if (event.key.toLowerCase() === 'k') {
                event.preventDefault();
                listPanel.current?.querySelector<HTMLInputElement>('.search-wrap input')?.focus();
            }
        };
        document.addEventListener('keydown', keydown);
        return () => document.removeEventListener('keydown', keydown);
    }, []);
    useEffect(() => { const timer = setTimeout(refreshMessages, 180); return () => clearTimeout(timer); }, [refreshMessages]);
    useEffect(() => {
        if (activeUID === null || !serviceReady) {
            setDetail(null);
            return;
        }
        let cancelled = false;
        setDetail(null);
        request<MessageDetail>('messages.get', { account: selected, folder, uid: activeUID })
            .then(async (item) => {
            if (cancelled)
                return;
            setDetail(item);
            setTab(item.html ? 'html' : 'text');
            await request('messages.markRead', { account: selected, folder, uid: activeUID });
            if (!cancelled)
                setMessages((items) => items.map((item) => item.uid === activeUID ? { ...item, unread: false } : item));
        })
            .catch((cause) => {
            if (!cancelled)
                setError(errorMessage(cause));
        });
        return () => { cancelled = true; };
    }, [activeUID, selected, folder, serviceReady]);
    const current = useMemo(() => messages.find((item) => item.uid === activeUID), [messages, activeUID]);
    const chooseMailbox = (account: string, nextFolder = 'INBOX') => {
        if (account !== 'catchall' && sidebarReady)
            saveExpansion(account, true);
        listRequest.current++;
        setCheckedUIDs(new Set());
        setAllMatching(false);
        setSelected(account);
        setFolder(nextFolder);
        setActiveUID(null);
        setDetail(null);
        setQuery('');
    };
    const toggleAccount = (address: string) => {
        const next = !expandedRef.current[address];
        saveExpansion(address, next);
        if (next)
            chooseMailbox(address);
    };
    const openConnection = async (address?: string) => {
        try {
            setSettings(await request<Settings>('settings.get'));
            setConnectionAddress(address || (selected !== 'catchall' ? selected : accounts[0]?.address || ''));
            setError('');
            setModal('connection');
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const openPasswordChange = (address: string) => { setEditingAccount(address); setError(''); setModal('changePassword'); };
    const openSettings = async () => {
        try {
            setSettings(await request<Settings>('settings.get'));
            setModal('settings');
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const createAccount = async () => {
        setBusy(true);
        try {
            const value = await request<{
                address: string;
                password: string;
            }>('accounts.create', { address: newAddress, password: newPassword });
            setRevealed(value);
            setModal('password');
            setNewAddress('');
            setNewPassword('');
            await refreshAccounts();
            chooseMailbox(value.address);
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
        finally {
            setBusy(false);
        }
    };
    const sendMessage = async () => {
        setBusy(true);
        try {
            await request('compose.send', { from: composeFrom, to: composeTo.split(/[;,\s]+/).filter(Boolean), subject: composeSubject, text: composeText });
            setModal(null);
            setComposeTo('');
            setComposeSubject('');
            setComposeText('');
            setNotice(translate("Test email delivered locally"));
            setTimeout(() => setNotice(''), 3500);
            if (selected === composeFrom && folder === 'Sent')
                refreshMessages();
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
        finally {
            setBusy(false);
        }
    };
    const applyMessageAction = async (action: 'trash' | 'restore' | 'delete' | 'read' | 'unread', singleUID?: number) => {
        const sameView = () => currentView.current.account === selected && currentView.current.folder === folder && currentView.current.query === query;
        const all = singleUID === undefined && allMatching;
        const uids = singleUID === undefined ? [...checkedUIDs] : [singleUID];
        if (!all && !uids.length)
            return;
        if (action === 'delete' && !window.confirm(translate("Permanently delete the selected email(s)? This cannot be undone.")))
            return;
        setActionBusy(true);
        try {
            const result = await request<{
                count: number;
            }>('messages.update', { account: selected, folder, uids, all, query, action });
            if (sameView()) {
                if (action !== 'read' && (all || (activeUID !== null && uids.includes(activeUID)))) {
                    setActiveUID(null);
                    setDetail(null);
                }
                setCheckedUIDs(new Set());
                setAllMatching(false);
            }
            const actions = {
                trash: {one:'{count} email moved to Trash',other:'{count} emails moved to Trash'},
                restore:{one:'{count} email restored to Inbox',other:'{count} emails restored to Inbox'},
                delete:{one:'{count} email permanently deleted',other:'{count} emails permanently deleted'},
                read:{one:'{count} email marked as read',other:'{count} emails marked as read'},
                unread:{one:'{count} email marked as unread',other:'{count} emails marked as unread'}
            };
            setNotice(plural(result.count,actions[action]));
            setTimeout(() => setNotice(''), 4000);
            await refreshMessages();
            await refreshFolders();
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
        finally {
            setActionBusy(false);
        }
    };
    const toggleAll = (checked: boolean) => { const selecting = checked && messages.length > 0; setAllMatching(selecting); setCheckedUIDs(new Set(selecting ? messages.map((message) => message.uid) : [])); };
    const toggleMessage = (uid: number, checked: boolean) => {
        setCheckedUIDs((current) => { const next = new Set(allMatching ? messages.map((message) => message.uid) : current); checked ? next.add(uid) : next.delete(uid); return next; });
        setAllMatching(false);
    };
    const selectionCount = allMatching ? messages.length : checkedUIDs.size;
    const downloadAttachment = async (item: Attachment) => {
        if (activeUID === null)
            return;
        try {
            const result = await request<Attachment>('messages.attachment', { account: selected, folder, uid: activeUID, index: item.index });
            const bytes = Uint8Array.from(atob(result.data || ''), (char) => char.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: result.type || 'application/octet-stream' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = result.name;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const saveSettings = async () => {
        setBusy(true);
        try {
            const result = await request<{
                restartRequired: boolean;
                startup: Status['startup'];
            }>('settings.update', settings);
            setNotificationsEnabled(settings.notificationsEnabled);
            setSavedTheme(settings.theme);
            setStatus(await request<Status>('status'));
            setError(result.startup?.error || '');
            setModal(result.startup?.error ? 'settings' : null);
            if (result.restartRequired) {
                setModal(null);
                setRestartTarget('service');
            }
            setNotice(translate("Settings saved"));
            setTimeout(() => setNotice(''), 3000);
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
        finally {
            setBusy(false);
        }
    };
    const changeAccountPassword = async (password: string) => {
        setBusy(true);
        try {
            const value = await request<{
                address: string;
                password: string;
            }>('accounts.updatePassword', { address: editingAccount, password });
            setRevealed(value);
            setModal('password');
            setError('');
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
        finally {
            setBusy(false);
        }
    };
    const removeAccount = async (address: string) => {
        if (!window.confirm(translate('Delete {address} and all of its test mail?',{address})))
            return;
        try {
            await request('accounts.delete', { address });
            if (selected === address)
                chooseMailbox('catchall');
            await refreshAccounts();
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const restartService = async () => {
        try {
            await window.mailgrid.restart();
            setStatus(await request<Status>('status'));
            await refreshAccounts();
            setError('');
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const openPermission = (kind: 'notifications' | 'startup' | 'privacy') => { void window.mailgrid.openSystemSettings(kind).catch(cause => setError(errorMessage(cause))); };
    const performRestart = async () => {
        setBusy(true);
        try {
            if (restartTarget === 'app') {
                await window.mailgrid.relaunch();
                return;
            }
            await restartService();
            setRestartTarget(null);
            setStatus(await request<Status>('status'));
        }
        catch (cause) {
            setError(errorMessage(cause));
            setRestartTarget(null);
        }
        finally {
            setBusy(false);
        }
    };
    return <div className={"app-shell"}><aside className={"sidebar"}><div className={"brand"}><div className={"brand-mark"}><Mail size={20} strokeWidth={2.3}/></div><div><strong>{translate("Mail Grid")}</strong><small>{translate("LOCAL EMAIL STUDIO")}</small></div></div><button className={"compose-button"} onClick={() => setModal(`compose`)} disabled={!accounts.length || !serviceReady}><Plus size={18}/>{translate(" Compose email")}</button><div className={"side-scroll"}><div className={"side-label"}>{translate("WORKSPACE")}</div><button className={`nav-item ${selected === `catchall` && folder === `INBOX` ? `selected` : ``}`} onClick={() => chooseMailbox(`catchall`)} aria-label={translate("Catch-all inbox")}><Inbox size={18}/><span className={"account-name"}>{translate("Catch-all inbox")}</span><UnreadCount count={unread.accounts.catchall?.total}/></button>{selected === `catchall` && <div className={"account-folders"}><button className={folder === `Trash` ? "active" : ``} onClick={() => chooseMailbox(`catchall`, `Trash`)}><Trash2 size={15}/>{translate(" Trash")}</button></div>}<div className={"side-label accounts-label"}><span>{translate("ACCOUNTS")}</span><button className={"icon-only small"} title={translate("Add account")} onClick={() => setModal(`account`)}><Plus size={16}/></button></div>{accounts.length === 0 && <p className={"sidebar-hint"}>{translate("Create your first local email account.")}</p>}{accounts.map(e => <AccountTree address={e.address} expanded={expandedAccounts[e.address] === !0} ready={sidebarReady && serviceReady} selected={selected} folder={folder} revision={folderRevision} counts={unread.accounts[e.address]} onToggle={() => toggleAccount(e.address)} onFolder={t => chooseMailbox(e.address, t)} onError={handleTreeError} key={e.address}/>)}</div><div className={"sidebar-bottom"}><button className={`sidebar-action ${updates?.release ? `update-notice` : ``}`} onClick={() => setShowUpdates(!0)}><ArrowDownToLine size={17}/>{updates?.phase === `ready` ? translate("Update ready to install") : updates?.phase === 'paused'?translate('Download paused'):updates?.phase === 'retrying'?translate('Waiting to resume download'):updates?.phase === 'verifying'?translate('Verifying download…'):updates?.phase === `downloading` ? translate('Downloading update {percent}%',{percent:number(Math.floor(updates.progress||0))}) : updates?.release ? translate('Update available · {version}',{version:updates.release.version}) : translate("Software updates")}{updates?.release && <span className={"update-dot"}/>}</button><button className={"sidebar-action"} onClick={() => openConnection()}><CircleHelp size={17}/>{translate(" Connection settings")}</button><button className={"sidebar-action"} onClick={() => setModal(`accounts`)}><Settings2 size={17}/>{translate(" Accounts & passwords")}</button><button className={"sidebar-action"} onClick={openSettings}><Settings2 size={17}/>{translate(" Settings")}</button>{(status?.startup?.error || status?.notificationStatus) && <button className={"sidebar-action permission-notice"} onClick={openSettings}><ShieldCheck size={16}/>{translate("Review system permissions")}</button>}{(status?.restartPending || appRestartPending) && <button className={"sidebar-action restart-notice"} onClick={() => setRestartTarget(appRestartPending ? `app` : `service`)}><RefreshCw size={16}/>{appRestartPending ? translate("App restart available") : translate("Restart mail service")}</button>}<div className={"service-indicator"}><span className={serviceReady ? "status-dot" : "status-dot offline"}/>{serviceReady ? translate("Mail service running") : translate("Mail service offline")}</div></div></aside><section className={"mail-list-panel"} ref={listPanel} tabIndex={-1} onKeyDown={e => { (e.target as HTMLElement).closest(`input:not([type="checkbox"]),textarea,[contenteditable="true"]`) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === `a` && (e.preventDefault(), toggleAll(!0)), e.key === `Escape` && toggleAll(!1)); }}><div className={"panel-heading"}><div className={"eyebrow"}>{translate("MAILBOX")}</div><div className={"heading-line"}><h1>{folder === `Trash` ? translate("Trash") : selected === `catchall` ? translate("Catch-all inbox") : folder === `Sent` ? translate("Sent mail") : folder === `INBOX` ? translate("Inbox") : folder}</h1><button className={"icon-only"} title={translate("Refresh")} onClick={refreshMessages}><RefreshCw size={17} className={busy ? "spin" : ``}/></button></div><p>{selected === `catchall` ? translate("Every address without a local account lands here.") : selectedAccount}</p><div className={"mailbox-actions"}><button onClick={() => openConnection()}><Copy size={13}/>{translate(" Connection settings")}</button>{selected !== `catchall` && <button onClick={() => setModal(`accounts`)}><Settings2 size={13}/>{translate(" Manage account")}</button>}</div></div><div className={"search-wrap"}><Search size={17}/><input value={query} onChange={e => { setQuery(e.target.value), toggleAll(!1); }} placeholder={translate("Search messages")} aria-label={translate("Search messages")}/><span className={"shortcut"}>{translate("\u2318 K")}</span></div><div className={"list-meta"}><label className={"select-all"}><input type={"checkbox"} aria-label={translate("Select all matching messages")} checked={allMatching && messages.length > 0} ref={e => { e && (e.indeterminate = !allMatching && checkedUIDs.size > 0); }} disabled={!messages.length || actionBusy} onChange={e => toggleAll(e.target.checked)}/><span>{selectionCount ? allMatching ? translate("All matching selected") : translate('{count} selected',{count:number(selectionCount)}) : messages.length===500?translate('{count}+ messages',{count:number(messages.length)}):plural(messages.length,{one:'{count} message',other:'{count} messages'})}</span></label><span>{translate("Newest first ")}<ChevronDown size={13}/></span></div>{selectionCount > 0 && <div className={"bulk-actions"}><button title={translate("Mark selected as read")} onClick={() => applyMessageAction(`read`)} disabled={actionBusy}><MailOpen size={14}/>{translate(" Read")}</button><button title={translate("Mark selected as unread")} onClick={() => applyMessageAction(`unread`)} disabled={actionBusy}><Mail size={14}/>{translate(" Unread")}</button>{folder === `Trash` && <button onClick={() => applyMessageAction(`restore`)} disabled={actionBusy}><Undo2 size={14}/>{translate(" Restore to Inbox")}</button>}<button onClick={() => applyMessageAction(folder === `Trash` ? `delete` : `trash`)} disabled={actionBusy}><Trash2 size={14}/>{folder === `Trash` ? translate("Delete forever") : translate("Move to Trash")}</button><button onClick={() => toggleAll(!1)} disabled={actionBusy}>{translate("Clear selection")}</button></div>}<div className={"message-list"}>{messages.length === 0 && <div className={"empty-list"}><div className={"empty-icon"}><MailPlus size={27}/></div><h3>{query ? translate("No matching mail") : translate("Your inbox is ready")}</h3><p>{query ? translate("Try another sender, recipient, or subject.") : translate("Send an email to 127.0.0.1 using the SMTP settings and it will appear here.")}</p><button className={"text-button"} onClick={() => openConnection()}>{translate("View connection settings \u2192")}</button></div>}{messages.map(e => <div className={`message-row ${activeUID === e.uid ? `active` : ``} ${e.unread ? `unread` : ``} ${allMatching || checkedUIDs.has(e.uid) ? `checked` : ``}`} key={e.uid}><input className={"message-checkbox"} type={"checkbox"} aria-label={translate('Select {subject}',{subject:e.subject||translate('(no subject)')})} checked={allMatching || checkedUIDs.has(e.uid)} onChange={t => toggleMessage(e.uid, t.target.checked)} disabled={actionBusy}/><button className={"message-open"} onClick={t => { t.metaKey || t.ctrlKey ? toggleMessage(e.uid, !(allMatching || checkedUIDs.has(e.uid))) : setActiveUID(e.uid); }}><span className={"message-dot"}>{e.unread ? translate("\u2022") : ``}</span><span className={"message-content"}><span className={"message-top"}><strong>{e.from || translate("(unknown sender)")}</strong><time>{dateLabel(e.date)}</time></span><span className={"message-subject"}>{e.subject || translate("(no subject)")}</span><span className={"message-preview"}>{translate("To ")}{e.to || translate("a local recipient")}{` · `}{formatSize(e.size)}</span></span></button></div>)}</div></section><main className={"reader-panel"}><div className={"reader-toolbar"}><span className={"toolbar-label"}>{translate("MESSAGE PREVIEW")}</span><div><button className={"secondary delete-mail-button"} onClick={() => activeUID !== null && applyMessageAction(current?.unread ? `read` : `unread`, activeUID)} disabled={!detail || actionBusy}><Mail size={15}/>{current?.unread ? translate("Mark as read") : translate("Mark as unread")}</button>{folder === `Trash` && <button className={"secondary delete-mail-button"} onClick={() => activeUID !== null && applyMessageAction(`restore`, activeUID)} disabled={!detail || actionBusy}><Undo2 size={15}/>{translate(" Restore")}</button>}<button className={"secondary delete-mail-button"} title={translate("Delete message")} onClick={() => activeUID !== null && applyMessageAction(folder === `Trash` ? `delete` : `trash`, activeUID)} disabled={!detail || actionBusy}><Trash2 size={15}/>{folder === `Trash` ? translate("Delete forever") : translate("Move to Trash")}</button></div></div>{detail ? <div className={"reader-content"}><button className={"back-button"} onClick={() => setActiveUID(null)}><ArrowLeft size={16}/>{translate(" Back to messages")}</button><div className={"message-header"}><div className={"message-category"}><span className={"category-dot"}/>{translate(" LOCAL MESSAGE")}</div><h2>{detail.subject || translate("(no subject)")}</h2><div className={"sender-line"}><div className={"sender-avatar"}>{(detail.from.match(/[a-z0-9]/i)?.[0] || `?`).toUpperCase()}</div><div className={"sender-details"}><strong>{detail.from || translate("(unknown sender)")}</strong><span>{translate("To: ")}{detail.deliveredTo || detail.to || translate("(unknown recipient)")}</span></div><span className={"full-date"}>{current?.date ? new Date(current.date * 1e3).toLocaleString(currentLanguage()) : detail.date}</span></div></div>{detail.attachments.length > 0 && <div className={"attachment-section"}><div className={"attachment-title"}>{translate("ATTACHMENTS ")}<span>{number(detail.attachments.length)}</span></div><div className={"attachments"}>{detail.attachments.map(e => <button onClick={() => downloadAttachment(e)} key={e.index}><FileText size={18}/><span><strong>{e.name}</strong><small>{formatSize(e.size)}</small></span><ArrowDownToLine size={16}/></button>)}</div></div>}<div className={"preview-section"}><div className={"preview-tabs"}>{[`html`, `text`, `headers`, `raw`].map(e => <button className={tab === e ? "active" : ``} onClick={() => setTab(e as ViewTab)} key={e}>{e === `html` ? translate("HTML preview") : e === `text` ? translate("Plain text") : e === `headers` ? translate("Headers") : translate("Raw source")}</button>)}</div><div className={"preview-body"} tabIndex={0}>{tab === `html` ? previewHTML ? <iframe title={translate("Safe email preview")} sandbox={"allow-popups"} srcDoc={previewHTML}/> : <div className={"no-content"}>{translate("This email has no readable content.")}</div> : tab === `text` ? <LinkedText text={detail.text || translate('This email has no plain text version.')} onError={e => setError(errorMessage(e))}/> : <pre>{tab === `headers` ? detail.headers : detail.raw}</pre>}</div></div></div> : <div className={"reader-empty"}><div className={"reader-empty-illustration"}><div className={"envelope-back"}/><Mail size={53} strokeWidth={1.25}/></div><h2>{translate("See every detail of your test emails")}</h2><p>{translate("Select a message to inspect its content, headers, raw source, and attachments.")}</p><div className={"safe-note"}><ShieldCheck size={17}/>{translate(" Everything stays on this computer")}</div></div>}</main>{incoming && <div className={"incoming-toast"} role={"status"}><div className={"incoming-title"}><Bell size={16}/>{translate(" New email")}<button className={"icon-only"} aria-label={translate("Dismiss new email notification")} onClick={() => setIncoming(null)}><X size={15}/></button></div><strong>{incoming.subject || translate("(no subject)")}</strong><p>{incoming.from || translate("Unknown sender")}</p>{status?.notificationStatus && <button className={"text-button"} onClick={() => openPermission(`notifications`)}>{translate("Enable system notifications \u2192")}</button>}<button className={"text-button"} onClick={() => { chooseMailbox(incoming.account || `catchall`), setIncoming(null); }}>{translate("Open inbox \u2192")}</button></div>}{(copied || notice) && <div className={"toast"} role={"status"} aria-live={"polite"}><Check size={16}/>{copied || notice}</div>}{error && <div className={"error-banner"} role={"alert"}><span>{error}</span>{!serviceReady && <button onClick={restartService}>{translate("Retry")}</button>}<button aria-label={translate("Dismiss error")} onClick={() => setError(``)}><X size={17}/></button></div>}{modal && <div className={"modal-backdrop"} onMouseDown={e => { e.target === e.currentTarget && setModal(null); }}><div className={`modal ${modal === `compose` ? `compose-modal` : modal === `connection` || modal === `accounts` ? `wide-modal` : ``}`} role={"dialog"} aria-modal={"true"}><div className={"modal-heading"}><div><span className={"eyebrow"}>{translate("MAIL GRID")}</span><h2>{modal === `account` ? translate("Create local account") : modal === `compose` ? translate("Compose test email") : modal === `settings` ? translate("Settings") : modal === `connection` ? translate("Connection settings") : modal === `accounts` ? translate("Accounts & passwords") : modal === `changePassword` ? translate("Change account password") : translate("Account password")}</h2></div><button className={"icon-only"} aria-label={translate("Close dialog")} onClick={() => setModal(null)}><X size={20}/></button></div>{modal === `account` && <><p className={"modal-intro"}>{translate("Create an address you can open in Thunderbird or use in your application tests.")}</p><label>{translate("Email address")}<input value={newAddress} onChange={e => setNewAddress(e.target.value)} placeholder={translate("alice@mailgrid.test")} autoFocus={!0}/></label><label>{translate("Password ")}<span className={"optional"}>{translate("optional")}</span><input type={"password"} value={newPassword} onChange={e => setNewPassword(e.target.value)} placeholder={translate("Leave blank to generate a secure password")}/></label><p className={"field-help"}>{translate("No length or complexity rules. Leave blank to generate a password. Connection settings are available after creating the account.")}</p><div className={"modal-actions"}><button className={"secondary"} onClick={() => setModal(null)}>{translate("Cancel")}</button><button className={"primary"} onClick={createAccount} disabled={busy || !newAddress.trim()}>{translate("Create account")}</button></div></>}{modal === `password` && revealed && <><p className={"modal-intro"}>{translate("Use this password in your app or mail client. Open Connection settings to copy your complete Laravel configuration.")}</p><div className={"credential-box"}><span>{revealed.address}</span><strong>{revealed.password}</strong></div><div className={"modal-actions"}><button className={"secondary"} onClick={() => window.mailgrid.copy(revealed.password, `Account password`)}>{translate("Copy password")}</button><button className={"secondary"} onClick={() => openConnection(revealed.address)}>{translate("Connection settings")}</button><button className={"primary"} onClick={() => { setModal(null), setRevealed(null); }}>{translate("Done")}</button></div></>}{modal === `compose` && <><p className={"modal-intro"}>{translate("This message will be delivered only to Mail Grid mailboxes on this computer.")}</p><label>{translate("From")}<select value={composeFrom} onChange={e => setComposeFrom(e.target.value)}>{accounts.map(e => <option value={e.address} key={e.address}>{e.address}</option>)}</select></label><label>{translate("To")}<input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder={translate("bob@mailgrid.test, anyone@example.com")}/></label><label>{translate("Subject")}<input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} placeholder={translate("A test email")}/></label><label>{translate("Message")}<textarea rows={8} value={composeText} onChange={e => setComposeText(e.target.value)} placeholder={translate("Write your test email\u2026")}/></label><div className={"modal-actions"}><button className={"secondary"} onClick={() => setModal(null)}>{translate("Cancel")}</button><button className={"primary"} onClick={sendMessage} disabled={busy || !composeTo.trim()}><Send size={16}/>{translate(" Send locally")}</button></div></>}{modal === `accounts` && <AccountManager accounts={accounts} onCreate={() => setModal(`account`)} onConnect={openConnection} onPassword={openPasswordChange} onDelete={removeAccount}/>}{modal === `changePassword` && <ChangePassword address={editingAccount} onSave={changeAccountPassword} busy={busy} key={editingAccount}/>}{modal === `connection` && status?.restartPending && <p className={"restart-connection-note"}>{translate("Showing the ports currently in use. Restart the mail service to apply your saved port changes.")}</p>}{modal === `connection` && <ConnectionSettings accounts={accounts} address={connectionAddress} ports={status?.ports || settings.ports} onAccount={setConnectionAddress} onPassword={openPasswordChange} onCreate={() => setModal(`account`)}/>}{modal === `settings` && <SettingsPanel value={settings} onChange={setSettings} status={status} busy={busy} onSave={saveSettings} onCancel={() => setModal(null)} onAccounts={() => setModal(`accounts`)} onPermission={openPermission} onTest={() => { window.mailgrid.testNotification().catch(e => setError(errorMessage(e))); }} onRestart={() => { setModal(null), setAppRestartPending(!0), setRestartTarget(`app`); }}/>}</div></div>}{restartTarget && <RestartPrompt target={restartTarget} busy={busy} updateReady={!1} onNow={async () => {
                setBusy(!0);
                try {
                    if (restartTarget === `app`) {
                        await window.mailgrid.relaunch();
                        return;
                    }
                    await restartService(), setRestartTarget(null), setStatus(await request(`status`));
                }
                catch (e) {
                    setError(errorMessage(e)), setRestartTarget(null);
                }
                finally {
                    setBusy(!1);
                }
            }} onDismiss={() => setRestartTarget(null)}/>}{showUpdates && <UpdatesPanel state={updates} onChange={setUpdates} onClose={() => setShowUpdates(!1)} hasDraft={!!(composeTo || composeSubject || composeText)}/>}</div>;
}
export default App;

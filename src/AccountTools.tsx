import { t as translate } from './i18n';
import { errorMessage } from './errors';
import { useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound, Plus, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import type { Account, Ports } from './types';
import { laravelConfig } from './connection';
type Credential = {
    address: string;
    password: string | null;
    persistent: boolean;
};
const request = <T,>(method: string, params?: unknown) => window.mailgrid.request<T>(method, params);
export function AccountManager({ accounts, onCreate, onConnect, onPassword, onDelete }: {
    accounts: Account[];
    onCreate: () => void;
    onConnect: (address: string) => void;
    onPassword: (address: string) => void;
    onDelete: (address: string) => void;
}) {
    return <><p className={"modal-intro"}>{translate("Manage the local email accounts your development apps and mail clients use.")}</p><div className={"account-cards"}>{accounts.map(({ address: e }) => <article className={"account-card"} key={e}><div className={"account-card-title"}><span className={"avatar"}>{e[0].toUpperCase()}</span><strong>{e}</strong></div><div className={"account-card-actions"}><button className={"secondary"} onClick={() => onConnect(e)}><Settings2 size={14}/>{translate(" Connection settings")}</button><button className={"secondary"} onClick={() => onPassword(e)}><KeyRound size={14}/>{translate(" Change password")}</button><button className={"danger-button"} onClick={() => onDelete(e)}><Trash2 size={14}/>{translate(" Delete account")}</button></div></article>)}</div>{!accounts.length && <div className={"account-empty"}><KeyRound size={25}/><h3>{translate("Create your first account")}</h3><p>{translate("Choose any email address and a test password. Mail Grid will give you the settings to paste into your app.")}</p></div>}<div className={"modal-actions"}><button className={"primary"} onClick={onCreate}><Plus size={16}/>{translate(" Add account")}</button></div></>;
}
export function ChangePassword({ address, onSave, busy }: {
    address: string;
    onSave: (password: string) => Promise<void>;
    busy: boolean;
}) {
    const [password, setPassword] = useState('');
    const [show, setShow] = useState(false);
    return <form onSubmit={e => { e.preventDefault(), onSave(password); }}><p className={"modal-intro"}>{translate('Change the password for {address}. Existing mail is kept. Update the password in your application and mail clients afterward.',{address})}</p><label>{translate("New password")}<div className={"password-input"}><input type={show ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} autoFocus={!0} autoComplete={"new-password"} placeholder={translate("Your test password, e.g. green")}/><button type={"button"} className={"icon-only"} aria-label={show ? translate("Hide new password") : translate("Show new password")} onClick={() => setShow(!show)}>{show ? <EyeOff size={17}/> : <Eye size={17}/>}</button></div></label><p className={"field-help"}>{translate("No length or complexity rules. Leave blank to generate a password.")}</p><div className={"modal-actions"}><button className={"primary"} disabled={busy} type={"submit"}>{translate("Save password")}</button></div></form>;
}
export function ConnectionSettings({ accounts, address, ports, onAccount, onPassword, onCreate }: {
    accounts: Account[];
    address: string;
    ports: Ports;
    onAccount: (address: string) => void;
    onPassword: (address: string) => void;
    onCreate: () => void;
}) {
    const [credential, setCredential] = useState<Credential | null>(null);
    const [loading, setLoading] = useState(true);
    const [show, setShow] = useState(false);
    const [entered, setEntered] = useState('');
    const [error, setError] = useState('');
    const [copied, setCopied] = useState('');
    const [verifying, setVerifying] = useState(false);
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setCredential(null);
        setShow(false);
        setEntered('');
        setError('');
        setCopied('');
        if (!address) {
            setLoading(false);
            return;
        }
        request<Credential>('accounts.credentials', { address }).then((value) => {
            if (!cancelled)
                setCredential(value);
        })
            .catch((cause) => {
            if (!cancelled)
                setError(errorMessage(cause));
        }).finally(() => {
            if (!cancelled)
                setLoading(false);
        });
        return () => { cancelled = true; };
    }, [address]);
    const password = credential?.password;
    const ready = typeof password === 'string';
    const copy = async (value: string, label: string) => {
        try {
            await window.mailgrid.copy(value, label);
            setCopied(translate('{label} copied to clipboard',{label:translate(label)}));
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
    };
    const remember = async () => {
        setVerifying(true);
        setError('');
        try {
            await request('accounts.verifyPassword', { address, password: entered });
            setCredential(await request<Credential>('accounts.credentials', { address }));
            setEntered('');
        }
        catch (cause) {
            setError(errorMessage(cause));
        }
        finally {
            setVerifying(false);
        }
    };
    return <><p className={"modal-intro"}>{translate("Copy these settings into an app running on this computer. Every email is captured locally.")}</p>{accounts.length ? <label>{translate("Account")}<select value={address} onChange={e => onAccount(e.target.value)}>{accounts.map(e => <option value={e.address} key={e.address}>{e.address}</option>)}</select></label> : <div className={"guide-note"}><p>{translate("Create an account to get a username, password, and ready-to-copy Laravel settings.")}</p><button className={"primary"} onClick={onCreate}>{translate("Add account")}</button></div>}<div className={"connection-card"}>{[[`Mail host`, `127.0.0.1`], [`SMTP port`, String(ports.smtp)], [`IMAP port`, String(ports.imap)], [`POP3 port`, String(ports.pop3)]].map(([e, t]) => <div key={e}><span>{translate(e).toLocaleUpperCase()}</span><strong>{t}</strong><button className={"connection-copy"} aria-label={translate('Copy {label}',{label:translate(e).toLocaleLowerCase()})} onClick={() => copy(t, e)}><Copy size={12}/>{translate(" Copy")}</button></div>)}</div>{address && <><div className={"connection-credentials"}><div><span>{translate("Username / email")}</span><code>{address}</code><button className={"icon-only"} aria-label={translate("Copy username")} onClick={() => copy(address, `Username`)}><Copy size={16}/></button></div><div><span>{translate("Password")}</span><code>{loading ? translate("Loading\u2026") : ready ? show ? password : translate("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022") : translate("Enter or change password below")}</code><button className={"icon-only"} aria-label={show ? translate("Hide password") : translate("Show password")} disabled={!ready} onClick={() => setShow(!show)}>{show ? <EyeOff size={16}/> : <Eye size={16}/>}</button><button className={"icon-only"} aria-label={translate("Copy account password")} disabled={!ready} onClick={() => copy(password || '', `Account password`)}><Copy size={16}/></button></div></div>{!loading && !ready && <div className={"password-recovery"}><p>{translate("This account predates saved connection settings, or its saved password is unavailable. Enter its current password or choose a new one.")}</p><form onSubmit={e => { e.preventDefault(), remember(); }}><label>{translate("Current account password")}<input type={"password"} value={entered} onChange={e => setEntered(e.target.value)} autoComplete={"current-password"}/></label><button className={"secondary"} disabled={!entered || verifying}>{translate("Use this password")}</button></form></div>}<button className={"text-button password-change-link"} onClick={() => onPassword(address)}><KeyRound size={14}/>{translate(" Change this account\u2019s password")}</button><div className={"config-heading"}><div><h3>{translate("Laravel .env")}</h3><p>{translate("Paste into your project\u2019s .env file.")}</p></div><button className={"primary"} disabled={!ready} onClick={() => copy(laravelConfig(address, password || '', ports), `Laravel configuration`)}><Copy size={15}/>{translate(" Copy Laravel .env")}</button></div><pre className={"env-config"} aria-label={translate("Laravel environment configuration")}>{laravelConfig(address, ready ? show ? password : `••••••••` : `<enter account password>`, ports)}</pre><p className={"field-help"}>{ready ? translate("Copy includes the actual password, even while hidden. ") : ``}{translate('After changing Laravel settings, run {command}.',{command:'php artisan config:clear'})}</p>{ready && <p className={"field-help"}>{credential?.persistent ? translate("Saved on this computer using the system credential store.") : translate("Password available for this session. If secure storage is unavailable, enter it again after restarting Mail Grid.")}</p>}</>}<div className={"guide-note"}><ShieldCheck size={18}/><p>{translate("Encryption: None. SMTP authentication is optional; the configuration above uses this account\u2019s password. IMAP and POP3 require it. Keep Mail Grid running. Docker, WSL, and remote apps need additional network setup; these addresses are for apps on this computer.")}</p></div>{error && <p className={"inline-error"} role={"alert"}>{error}</p>}{copied && <p className={"inline-success"} role={"status"}>{copied}</p>}</>;
}

import { t as translate, number, plural } from './i18n';
import { useEffect, useState } from 'react';
import { ChevronDown, Folder, Inbox, Send, Trash2 } from 'lucide-react';
import type { UnreadCounts } from './types';
export function UnreadCount({ count = 0 }: {
    count?: number;
}) {
    return count > 0 ? <span className={"unread-badge"} aria-label={plural(count,{one:'{count} unread email',other:'{count} unread emails'})} title={plural(count,{one:'{count} unread email',other:'{count} unread emails'})}>{number(count)}</span> : null;
}
export function AccountTree({ address, expanded, ready, selected, folder, revision, counts, onToggle, onFolder, onError }: {
    address: string;
    expanded: boolean;
    ready: boolean;
    selected: string;
    folder: string;
    revision: number;
    counts?: UnreadCounts['accounts'][string];
    onToggle: () => void;
    onFolder: (folder: string) => void;
    onError: (cause: unknown) => void;
}) {
    const [folders, setFolders] = useState(['INBOX', 'Sent', 'Trash']);
    useEffect(() => {
        if (!expanded || !ready)
            return;
        let cancelled = false;
        window.mailgrid.request<string[]>('folders.list', { account: address }).then(names => {
            if (!cancelled)
                setFolders(['INBOX', 'Sent', 'Trash', ...names.filter(name => !['INBOX', 'Sent', 'Trash'].includes(name)).sort()]);
        }).catch(cause => {
            if (!cancelled)
                onError(cause);
        });
        return () => { cancelled = true; };
    }, [address, expanded, ready, revision, onError]);
    const id = `folders-${encodeURIComponent(address)}`;
    return <div className={"account-tree"} data-account={address}><button className={`nav-item account-nav ${selected === address ? `selected` : ``}`} aria-label={address} aria-expanded={expanded} aria-controls={id} onClick={onToggle} disabled={!ready}><ChevronDown className={`account-chevron ${expanded ? `expanded` : ``}`} size={13}/><span className={"avatar"}>{address[0].toUpperCase()}</span><span className={"truncate account-name"} title={address}>{address}</span><UnreadCount count={counts?.total}/></button>{expanded && <div className={"account-folders"} id={id}>{folders.map(t => <button className={selected === address && folder === t ? "active" : ``} onClick={() => onFolder(t)} aria-label={t === `INBOX` ? translate("Inbox") : ["Sent","Trash"].includes(t)?translate(t):t} key={t}>{t === `INBOX` ? <Inbox size={15}/> : t === `Sent` ? <Send size={15}/> : t === `Trash` ? <Trash2 size={15}/> : <Folder size={15}/>}<span className={"folder-name"}>{t === `INBOX` ? translate("Inbox") : ["Sent","Trash"].includes(t)?translate(t):t}</span><UnreadCount count={counts?.folders[t]}/></button>)}</div>}</div>;
}

export type Account = { address: string; created: number };
export type UnreadCounts = { total: number; accounts: Record<string, { total: number; folders: Record<string, number> }> };
export type SidebarState = { expandedAccounts: Record<string, boolean> };
export type Ports = { smtp: number; imap: number; pop3: number };
export type Settings = { ports: Ports; retentionDays: number; startAtLogin: boolean; notificationsEnabled: boolean; theme: 'system' | 'light' | 'dark' };
export type MessageSummary = { uid: number; subject: string; from: string; to: string; date: number; size: number; unread: boolean };
export type Attachment = { index: number; name: string; type: string; size: number; data?: string };
export type MessageDetail = {
  uid: number; subject: string; from: string; to: string; deliveredTo: string; date: string;
  text: string; html: string; raw: string; headers: string; attachments: Attachment[];
};
export type Status = { running: boolean; ports: Ports; configuredPorts?: Ports; restartPending?: boolean; updateReady?: boolean; dataDir: string; error?: string; startup?: { requested: boolean; enabled: boolean; error: string; status?: string }; notificationStatus?: string };

declare global {
  interface Window {
    mailgrid: {
      request<T>(method: string, params?: unknown): Promise<T>;
      openSystemSettings(kind: 'notifications' | 'startup' | 'privacy'): Promise<void>;
      testNotification(): Promise<void>;
      relaunch(): Promise<void>;
      restart(): Promise<{ running: boolean }>;
      openExternal(url: string): Promise<void>;
      copy(value: string, label?: string): Promise<boolean>;
      onEvent(callback: (event: string, data: unknown) => void): () => void;
    };
  }
}

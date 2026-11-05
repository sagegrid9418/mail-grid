# Mail Grid

A desktop email workspace for local development. Create named test accounts, capture mail addressed to anyone, compose local messages, and inspect HTML, text, headers, raw MIME, and attachments. SMTP, IMAP, and POP3 share the same persistent mailbox store.

Mail Grid binds to `127.0.0.1`. It has no internet delivery route, cloud account, or public HTTP API.

## Run from source

Requires Node.js 22.12 or newer, Go 1.27, and the build tools for your operating system. Python 3 is used by the protocol integration test.

```sh
npm ci
npm run build:engine
npm run dev
```

To run the built UI without the development server:

```sh
npm run build
npm start
```

If the Electron runtime has not been downloaded, run `npx install-electron`. Electron 45 installs its runtime through this command. Mail Grid also runs it in `postinstall`.

## Connect a development app

| Setting | Default |
| --- | --- |
| Host | `127.0.0.1` |
| SMTP port | `1025` |
| IMAP port | `1143` |
| POP3 port | `1110` |
| Encryption | None; loopback only |
| SMTP authentication | Optional |
| IMAP / POP3 authentication | A named account and its password |

Create an account such as `alice@mailgrid.test` in the sidebar. Messages to that address land in its Inbox. Unknown recipients, including addresses at real domains, land in Catch-all. The original SMTP recipients are retained in `X-MailGrid-Recipients`.

For example, a Laravel `.env` can use:

```dotenv
MAIL_MAILER=smtp
MAIL_HOST=127.0.0.1
MAIL_PORT=1025
MAIL_USERNAME=null
MAIL_PASSWORD=null
MAIL_ENCRYPTION=null
MAIL_FROM_ADDRESS=app@mailgrid.test
```

Authenticated SMTP and the built-in composer also store a Sent copy. Compose accepts any test recipient, and all delivery remains local. Messages have a 25 MB size limit and SMTP transactions accept at most 100 recipients.

## Thunderbird setup

1. Create a local account and save its generated password. Use Settings to reset a password if needed.
2. In Thunderbird, add an existing mail account and choose **Configure manually**.
3. Use the created email address as the incoming and outgoing username. Set incoming host to `127.0.0.1`, IMAP port `1143` or POP3 port `1110`, connection security **None**, and authentication **Normal password**.
4. Set SMTP host to `127.0.0.1`, port `1025`, connection security **None**, and authentication **Normal password**. A local test password is used only for Mail Grid.
5. If Thunderbird saves sent messages itself, configure its Sent mapping or disable its extra Sent copy to avoid duplicates with Mail Grid's authenticated-submission copy.

Ports are editable in Settings. Saving a port change offers **Restart now**, **Later**, or **Close**. Until restart, Connection settings shows the ports still running. A sidebar reminder lets you restart later. Settings remain accessible if a port is already occupied, so you can resolve the conflict. The window closes to the tray; choose Quit in the tray menu to stop capture. Login startup is enabled by default in installed builds and can be disabled in Settings.

## Storage and privacy

Mail and settings live in Electron's per-user application data directory. Raw MIME blobs and SQLite indexes are retained across restarts. Automatic retention is off by default; set a number of days in Settings to enable deletion. Account authentication uses bcrypt hashes (new hashes use SHA-256 prehashing so there is no password length limit). For copyable connection settings, the desktop app also saves an encrypted password using the system credential store when available. It keeps only a session copy if secure storage is unavailable; it never writes a plaintext password fallback. Existing accounts need their current password entered once in Connection settings, or a new password chosen.

Email HTML is sanitized and rendered in a sandboxed frame without script privileges or desktop bridge access. Remote content, scripts, unsafe URL schemes, and forms are removed. HTTP/HTTPS links in HTML and plain text open in the system browser only after a click. The frame allows popup requests solely to hand clicked links to Electron; Electron denies creating preview popup windows and opens only validated HTTP/HTTPS URLs externally. The preview currently omits inline/CID images as well. Attachments are downloaded explicitly by the user.

## Verification

```sh
npm run typecheck
npm run build
npm run test:engine
npm run test:integration
npm run test:desktop
```

The protocol test uses temporary data and high loopback ports. It exercises SMTP capture, catch-all routing, MIME and attachments, IMAP access, compose/Sent, POP3 deletion, and persistence. The desktop test uses a separate application data directory.

## Build installers

See [packaging/README.md](packaging/README.md) for current universal macOS DMG, Windows NSIS EXE and Linux DEB builds, and [RELEASING.md](RELEASING.md) for signed per-OS release bundles. Generated installers are not committed to this source repository.

Paid Apple/Windows certificates and notarization are optional. Free Ed25519 release verification and checksums remain required. Test real installation, updating, startup, notifications and Thunderbird on each target before claiming native compatibility.

## Architecture

`desktop/` owns the Electron lifecycle and validates the renderer's narrow IPC interface. It supervises a bundled Go child process over newline-delimited JSON on stdio. `engine/` owns account authentication, SMTP, IMAP, POP3, MIME parsing, and persistent storage. `src/` is the React mailbox interface.

The mail engine uses go-smtp, go-imap, go-imap-sql, and SQLite. Exact dependency versions are committed in the lock files. The independent protocol listeners never perform DNS/MX routing or forward to an external SMTP service.

## Accounts and application configuration

- Open **Accounts & passwords** in the sidebar to add an account, choose a new password, or delete an account and its mail. Passwords have no length or complexity rules; leaving the password blank generates one.
- Open **Connection settings** in the sidebar or the selected mailbox. Choose the account, view the host and SMTP/IMAP/POP3 ports, and show or copy its username and password.
- Click **Copy Laravel .env** to copy all eight mail settings, including the actual password and the active SMTP port. Paste the block into the project's `.env` file and run `php artisan config:clear`.
- After changing a password, copy the settings again and update any connected mail clients. Changing a password keeps the account's mail.
- These settings use `127.0.0.1` and apply to applications on the same computer. Docker, WSL, VMs, and remote applications need additional network setup; Mail Grid still listens on loopback only.

## Mail actions and notifications

- Use the message checkboxes for multiple selection. The header checkbox or Ctrl/Cmd+A while focused in the message list selects **all messages matching the current search**, including messages beyond the first 500 displayed. Uncheck a row to select only the remaining visible messages. Escape clears selection.
- Mark selected messages read/unread or move them to **Trash**. Every account and the catch-all inbox has its own Trash folder. Restore puts messages into Inbox. **Delete forever** is available in Trash and asks for confirmation. POP3 committed deletions also move messages to Trash; IMAP clients can move messages into Trash, while an explicit IMAP expunge still follows normal permanent-delete semantics.
- Every copy button confirms **Copied to clipboard** in a visible toast above dialogs. Connection settings have individual **Copy** buttons for the host, SMTP, IMAP, POP3, username, and password, plus the complete Laravel configuration.
- Right-click selected content to copy it. Right-click a link to copy its address or open it in the browser. Editable fields also offer cut/paste, undo/redo, and Select All scoped to the field. Application chrome cannot be selected as one block of text. Email content and configuration text remain selectable.
- Settings → **Startup & notifications** controls login startup and incoming-mail pop-ups independently. Startup preferences are persisted and the UI reports system registration failures instead of claiming that startup is enabled. System permissions and signing requirements still apply.
- A received message shows its sender and subject in the app. System notifications are requested even while the window is focused, with a small Mail Grid desktop pop-up if they fail or are unsupported. Click a notification to open the relevant inbox. macOS unsigned beta builds use the fallback when the system notification API rejects them.

## Appearance, permissions, and restarts

- Settings → **Appearance** offers Light, Dark, and Use system. Changes preview immediately; Save keeps the choice across launches, and Cancel restores the saved theme. System mode follows appearance changes while the app is running. Email HTML keeps any explicit colors supplied by its sender.
- Settings includes buttons for system Notifications, Startup, and Privacy settings, and a **Test notification** action. If notification delivery fails, the incoming alert offers a settings shortcut; registration and notification problems also show a **Review system permissions** shortcut in the sidebar. Operating systems may silently suppress alerts, so these shortcuts are available even without a detected failure.
- Windows and macOS open the corresponding system settings pages. GNOME and KDE launch their settings tools; available pages depend on the installed desktop environment. If a tool is unavailable, Mail Grid explains how to open settings manually.
- Port changes are saved without interrupting capture until you approve a restart. Restarting disconnects active protocol sessions but retains stored mail. App restarts offer the same Now/Later/Close choices. Downloaded-update events use this prompt before installation; download behavior follows the user’s Manual/Automatic setting; installation requires Update now.
- Run `npm run test:preferences` to verify selection scope, copy feedback, foreground notifications, theme persistence, permission shortcuts, and deferred restarts in an isolated desktop instance.

## Unread badges and account navigation

- The app icon shows the total unread received mail across named accounts and catch-all. Account headers and expanded inbox/custom folders show their own unread counts. Sent, Trash, and messages flagged for deletion are excluded. Badges clear at zero, refresh while the window is hidden, and are recalculated from stored mail after launch.
- macOS uses the Dock badge, Windows uses a numeric taskbar overlay (99+ above 99), and Linux uses the desktop launcher badge where supported. OS notification/badge permissions and taskbar settings can affect visibility.
- Click an account header to expand or collapse it. Accounts expand independently. Clicking an expanded folder opens that mailbox. Each account’s expansion state is saved immediately and restored after closing or restarting; changing the app theme preserves it.
- `npm run test:sidebar` verifies account expansion, restart persistence, unread badge updates, hidden-window IMAP changes, and clearing counts after reading or moving mail to Trash.

## Downloadable local installers

The current beta installers are collected in `out/installers/`:

- `Mail-Grid-0.3.2-macOS-Universal.dmg` — Universal macOS, native Intel and Apple Silicon.
- `Mail-Grid-0.3.2-Windows-x64-Setup.exe` — Windows x64, per-user NSIS installer with Start menu shortcut and uninstaller.
- `mail-grid_0.3.2_amd64.deb` — Ubuntu/Debian AMD64, install with `sudo apt install ./mail-grid_0.3.2_amd64.deb`.

`INSTALL.txt` explains installation, and `SHA256SUMS` verifies the files. The Mac beta uses local/ad-hoc signatures; the Windows beta is unsigned. Paid platform certificates and notarization are optional. Free release signatures/checksums are required. Native clean-machine installation/update tests remain necessary before claiming platform verification. See [installer build instructions](packaging/README.md) for reproducible builds with `npm run installers`.

## macOS system registration and local signing

macOS notification registration depends on app identity, local code signatures, system permission and installation location. New universal builds use ad-hoc signing; an optional local development identity can also be used. `APPLE_SIGN_IDENTITY=... MAILGRID_DEVELOPMENT_SIGN=1 node scripts/sign-mac.mjs` signs a prepared app locally without exporting the private key. The signing script and Forge use minimal JIT entitlements and keep the same bundle identifier, `dev.mailgrid.app`.

On its first installed launch with notifications enabled, Mail Grid makes a native notification request so macOS can list it in Notifications. Choose Allow in the system prompt. If permission was previously denied, use Settings → Open system notification settings. Enable / test notifications can retry delivery. macOS login startup uses the main app service, reports when approval is needed, and refreshes its status when you return to Mail Grid. Startup registration remains separate from notification permission.

The sidebar footer stays fixed while the account list scrolls, even with many expanded accounts. Copy confirmations identify the field (for example, “Mail host copied to clipboard” or “SMTP port copied to clipboard”) without exposing the copied password.

## Desktop updates

Mail Grid uses a signed release feed at `https://mail-dev.sagegrid.org`. The release website and admin application are maintained separately and are not included in this repository. The app user chooses Manual or Automatic downloads; installation always requires **Update now**. See [RELEASING.md](RELEASING.md) and [SIGNING.md](SIGNING.md) for release verification and update-service requirements.

## First launch and offline interface languages (0.3.0)

Fresh profiles must finish language, theme, update-download mode and automatic-check choices before capture, notifications, startup registration or update polling begin. Default choices are English, System appearance, Manual downloads and automatic checks enabled. Quitting preserves unfinished choices. Existing profiles migrate without resetting preferences or forcing setup.

The single-select language control offers only complete bundled interface catalogs, with English first and Simplified/Traditional Chinese as separate choices. Arabic, Chinese, Dutch, French, German, Hausa, Hebrew, Hindi, Igbo, Indonesian, Italian, Japanese, Korean, Persian, Polish, Portuguese, Russian, Spanish, Swahili, Ukrainian and Yoruba work offline. Supported regional formatting is preserved until a language change; unsupported earlier choices migrate to English with a notice. The CLDR 48 inventory supplies locale identity and formatting. The build rejects missing text and accidental English placeholders. See `LANGUAGES.md` for scope, local translation maintenance and review limitations. Email content, addresses, HTML, source and code examples are never translated. HTML preview retains message-local styling inside an isolated frame while blocking scripts and remote resources.

Each OS/package can be released independently. Current clients use `/api/v2/releases/latest` for their compatible target. Older keyless installations need one manual installation of 0.3.0; subsequent updates use the embedded public verification key.


## Usability retouch (0.3.1)

Plain-text messages also render safely in HTML preview. Interface language uses a single dropdown with language names, English first, necessary script distinctions, and preserved existing regional preferences.

## Resumable verified updates (0.3.2)

Requested downloads retain partial progress across network failures and app restarts, even in Manual mode. Pause persists; Cancel discards the transfer and suppresses automatic restarting of that artifact until requested again. Signed metadata is revalidated before resuming, and SHA-256/SHA-512 are checked before native installation. Later, closing the update panel and ordinary quitting never install anything. Update now remains explicit. The first upgrade from an older downloader cannot resume until 0.3.2 is installed.

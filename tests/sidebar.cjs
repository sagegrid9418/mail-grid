const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const python = process.platform === 'win32' ? 'python' : 'python3';
const free = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const until = async fn => { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 80)); } throw new Error('Condition timed out'); };
(async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailgrid-sidebar-')); let app;
 const launch = async () => {
  const env = { ...process.env, MAILGRID_DATA_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ ...(process.env.MAILGRID_TEST_EXECUTABLE ? { executablePath: process.env.MAILGRID_TEST_EXECUTABLE } : {}), args: process.env.MAILGRID_TEST_EXECUTABLE ? ['--test-mode'] : [root, '--preview', '--test-mode'], env });
  await app.evaluate(({ app, BrowserWindow }) => {
   globalThis.badges = [];
   const badge = count => { globalThis.badges.push(count); return true; }; app.setBadgeCount = badge;
   const window = BrowserWindow.prototype;
   const overlay = (image, description) => { globalThis.badges.push(image ? Number(description.match(/^\d+/)[0]) : 0); }; window.setOverlayIcon = overlay;
   if (app.setBadgeCount !== badge || window.setOverlayIcon !== overlay) throw new Error('Could not isolate native badges');
  });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await page.getByText('Mail service running', { exact: true }).waitFor(); return page;
 };
 const alice = 'alice@mailgrid.test', bob = 'bob@mailgrid.test';
 const tree = (page, address) => page.locator('.account-tree').filter({ has: page.getByRole('button', { name: address, exact: true }) });
 const account = (page, address) => page.getByRole('button', { name: address, exact: true });
 const lastBadge = () => app.evaluate(() => globalThis.badges.at(-1));
 try {
  const ports = { smtp: await free(), imap: await free(), pop3: await free() };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ports, retentionDays: 0, startAtLogin: false, notificationsEnabled: false }));
  let page = await launch(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => { for (const address of ['alice@mailgrid.test', 'bob@mailgrid.test']) await window.mailgrid.request('accounts.create', { address, password: 'a' }); });
  await account(page, alice).waitFor(); await account(page, bob).waitFor();
  assert.equal(await account(page, alice).getAttribute('aria-expanded'), 'false');
  await account(page, alice).click(); await account(page, bob).click();
  assert.equal(await account(page, alice).getAttribute('aria-expanded'), 'true'); assert.equal(await account(page, bob).getAttribute('aria-expanded'), 'true');
  assert.equal(await tree(page, alice).getByRole('button', { name: 'Inbox', exact: true }).count(), 1);
  assert.equal(await tree(page, bob).getByRole('button', { name: 'Inbox', exact: true }).count(), 1);
  await account(page, alice).click(); assert.equal(await account(page, alice).getAttribute('aria-expanded'), 'false');
  assert.equal(await account(page, bob).getAttribute('aria-expanded'), 'true');
  // Saving theme must preserve sidebar state, and sidebar clicks must preserve theme.
  await page.evaluate(async () => { const settings = await window.mailgrid.request('settings.get'); await window.mailgrid.request('settings.update', { ...settings, theme: 'dark' }); });
  await account(page, alice).click(); await account(page, bob).click();
  await until(async () => { const s = await page.evaluate(() => window.mailgrid.request('sidebar.get')); return s.expandedAccounts[alice] === true && s.expandedAccounts[bob] === false; });
  assert.equal((await page.evaluate(() => window.mailgrid.request('settings.get'))).theme, 'dark');
  await page.reload(); await page.getByText('Mail service running', { exact: true }).waitFor();
  await until(async () => await account(page, alice).getAttribute('aria-expanded') === 'true');
  assert.equal(await account(page, bob).getAttribute('aria-expanded'), 'false');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await page.evaluate(async () => {
   for (const [subject, to] of [['Alpha', ['alice@mailgrid.test']], ['Beta', ['alice@mailgrid.test']], ['Other accounts', ['bob@mailgrid.test', 'unknown@example.test']]]) await window.mailgrid.request('compose.send', { from: 'alice@mailgrid.test', to, subject, text: 'Badge test' });
  });
  await until(async () => await lastBadge() === 4);
  await until(async () => await account(page, alice).locator('.unread-badge').innerText() === '2');
  assert.equal(await account(page, bob).locator('.unread-badge').innerText(), '1');
  assert.equal(await page.getByRole('button', { name: 'Catch-all inbox', exact: true }).locator('.unread-badge').innerText(), '1');
  // Change flags through an independent mail client; the hidden renderer does not query counts.
  execFileSync(python, ['-c', 'import imaplib,sys; c=imaplib.IMAP4("127.0.0.1",int(sys.argv[1])); c.login("bob@mailgrid.test","a"); c.select("INBOX"); assert c.store("1","+FLAGS",r"(\\Seen)")[0]=="OK"; c.logout()', String(ports.imap)]);
  await until(async () => await lastBadge() === 3);
  await until(async () => await account(page, bob).locator('.unread-badge').count() === 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await tree(page, alice).getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: /Alpha/ }).click();
  await until(async () => await lastBadge() === 2);
  await page.getByRole('button', { name: 'Mark as unread', exact: true }).click();
  await until(async () => await lastBadge() === 3);
  await page.getByRole('checkbox', { name: 'Select Alpha', exact: true }).check();
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).first().click();
  await until(async () => await lastBadge() === 2);
  assert.equal(await account(page, alice).locator('.unread-badge').innerText(), '1');
  await page.getByRole('button', { name: /Beta/ }).click(); await until(async () => await lastBadge() === 1);
  await page.getByRole('button', { name: 'Catch-all inbox', exact: true }).click();
  await page.getByRole('button', { name: /Other accounts/ }).click(); await until(async () => await lastBadge() === 0);
  await until(async () => await page.locator('.sidebar .unread-badge').count() === 0);
  // Two expanded accounts with different custom folders keep their own folder lists.
  execFileSync(python, ['-c', 'import imaplib,sys; c=imaplib.IMAP4("127.0.0.1",int(sys.argv[1])); c.login("bob@mailgrid.test","a"); assert c.create("Bob custom")[0]=="OK"; c.logout()', String(ports.imap)]);
  await account(page, bob).click(); await tree(page, bob).getByRole('button', { name: 'Bob custom', exact: true }).waitFor();
  assert.equal(await tree(page, alice).getByRole('button', { name: 'Bob custom', exact: true }).count(), 0);
  assert.equal(await account(page, alice).getAttribute('aria-expanded'), 'true');
  await account(page, bob).click();
  await assert.rejects(() => page.evaluate(() => window.mailgrid.request('sidebar.update', { address: 'alice@mailgrid.test', expanded: 'yes' })));
  await app.close(); app = null; page = await launch();
  await until(async () => await account(page, alice).getAttribute('aria-expanded') === 'true');
  assert.equal(await account(page, bob).getAttribute('aria-expanded'), 'false');
  await until(async () => await lastBadge() === 0);
  // A startup scan restores a persisted nonzero unread badge too.
  await page.evaluate(() => window.mailgrid.request('messages.update', { account: 'bob@mailgrid.test', folder: 'INBOX', all: true, action: 'unread' }));
  await until(async () => await lastBadge() === 1);
  await app.close(); app = null; page = await launch();
  await until(async () => await lastBadge() === 1);
  await until(async () => await account(page, bob).locator('.unread-badge').innerText() === '1');
  assert.equal(await account(page, alice).getAttribute('aria-expanded'), 'true'); assert.equal(await account(page, bob).getAttribute('aria-expanded'), 'false');
  // At minimum window height, expanded accounts scroll without moving the footer.
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) await window.mailgrid.request('accounts.create', { address: `overflow${i}@mailgrid.test`, password: 'a' });
  });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 620));
  await page.getByRole('button', { name: 'overflow11@mailgrid.test', exact: true }).waitFor({ state: 'attached' });
  const layout = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar'), footer = document.querySelector('.sidebar-bottom'), list = document.querySelector('.side-scroll');
    const bounds = footer.getBoundingClientRect();
    return { height: innerHeight, footerTop: bounds.top, footerBottom: bounds.bottom, sidebarHeight: sidebar.getBoundingClientRect().height, scrollable: list.scrollHeight > list.clientHeight };
  });
  assert(layout.scrollable); assert(layout.footerTop >= 0 && layout.footerBottom <= layout.height); assert.equal(layout.sidebarHeight, layout.height);
  await page.locator('.side-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  fs.mkdirSync(path.join(root, 'test-results'), { recursive: true }); await page.screenshot({ path: path.join(root, 'test-results', 'sidebar-badges.png') });
  assert.deepEqual(errors, []);
  console.log('PASS: independent account toggles, per-account folders, theme/sidebar persistence, exact unread badges, hidden-window IMAP flag updates, read/unread/Trash, badge clearing, restart restoration');
 } finally { if (app) await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

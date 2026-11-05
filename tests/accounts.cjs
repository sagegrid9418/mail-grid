const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { _electron: electron } = require('playwright');
const root = path.resolve(__dirname, '..');
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailgrid-accounts-'));
  const address = 'admin@flux-cargo.test';
  let app;
  const launch = async () => {
    const env = { ...process.env, MAILGRID_DATA_DIR: dir }; delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      ...(process.env.MAILGRID_TEST_EXECUTABLE ? { executablePath: process.env.MAILGRID_TEST_EXECUTABLE } : {}),
      args: process.env.MAILGRID_TEST_EXECUTABLE ? ['--test-mode'] : [root, '--preview', '--test-mode'], env,
    });
    // Capture Copy actions without changing the user's system clipboard.
    await app.evaluate(({ clipboard }) => {
      const capture = (text) => { globalThis.mailgridTestClipboard = text; };
      clipboard.writeText = capture;
      if (clipboard.writeText !== capture) throw new Error('Could not isolate test clipboard');
    });
    const page = await app.firstWindow();
    await page.getByText('Mail service running', { exact: true }).waitFor();
    return page;
  };
  const copied = () => app.evaluate(() => globalThis.mailgridTestClipboard);
  try {
    const ports = { smtp: await freePort(), imap: await freePort(), pop3: await freePort() };
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ports, retentionDays: 0, startAtLogin: false }));
    let page = await launch();
    await page.getByRole('button', { name: 'Accounts & passwords', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Add account', exact: true }).click();
    await page.getByLabel('Email address').fill(address);
    await page.getByLabel('Password', { exact: false }).fill('a');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connection settings', exact: true }).click();
    const copy = () => page.getByRole('button', { name: 'Copy Laravel .env', exact: true });
    await copy().click();
    let config = await copied();
    for (const line of ['MAIL_MAILER=smtp', 'MAIL_SCHEME=smtp', 'MAIL_HOST=127.0.0.1', `MAIL_PORT=${ports.smtp}`, `MAIL_USERNAME=${address}`, 'MAIL_PASSWORD=a', `MAIL_FROM_ADDRESS=${address}`, 'MAIL_FROM_NAME="${APP_NAME}"']) assert(config.split('\n').includes(line), line);
    const preview = () => page.getByLabel('Laravel environment configuration');
    assert(!(await preview().innerText()).includes('MAIL_PASSWORD=a'));
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    assert((await preview().innerText()).includes('MAIL_PASSWORD=a'));
    await page.getByRole('button', { name: 'Change this account’s password', exact: true }).click();
    await page.getByLabel('New password', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: 'Save password', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connection settings', exact: true }).click();
    await copy().click();
    assert((await copied()).includes('MAIL_PASSWORD=green'));
    await page.evaluate((address) => window.mailgrid.request('accounts.verifyPassword', { address, password: 'fixture-password' }), address);
    assert(await page.evaluate(async (address) => {
      try { await window.mailgrid.request('accounts.verifyPassword', { address, password: 'a' }); return false; } catch { return true; }
    }, address));
    await page.getByRole('button', { name: 'Show password', exact: true }).click();
    mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'connection-settings.png') });
    await app.close(); app = null;
    page = await launch();
    await page.getByRole('button', { name: 'Connection settings', exact: true }).first().click();
    await page.getByLabel('Current account password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Use this password', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /password does not match/ }).waitFor();
    await page.getByLabel('Current account password', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: 'Use this password', exact: true }).click();
    await copy().click();
    assert((await copied()).includes('MAIL_PASSWORD=green'));
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Accounts & passwords', exact: true }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete account', exact: true }).click();
    await page.getByRole('heading', { name: 'Create your first account', exact: true }).waitFor();
    assert.equal(await page.evaluate(async (address) => (await window.mailgrid.request('accounts.credentials', { address })).password, address), null);
    assert.deepEqual(await page.evaluate(() => window.mailgrid.request('accounts.list')), []);
    console.log('PASS: visible account actions, short/custom password, copied Laravel settings, restart/re-entry, wrong password rejection, deletion');
  } finally {
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

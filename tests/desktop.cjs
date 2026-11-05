const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { _electron: electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const listen = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const freePort = async () => { const server = await listen(); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; };

(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mailgrid-desktop-'));
  let app;
  let blocker;
  try {
    const ports = { smtp: await freePort(), imap: await freePort(), pop3: await freePort() };
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ports, retentionDays: 0, startAtLogin: false }));
    const env = { ...process.env, MAILGRID_DATA_DIR: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      ...(process.env.MAILGRID_TEST_EXECUTABLE ? { executablePath: process.env.MAILGRID_TEST_EXECUTABLE } : {}),
      args: process.env.MAILGRID_TEST_EXECUTABLE ? ['--test-mode'] : [root, '--preview', '--test-mode'],
      env,
      timeout: 30000,
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByText('Mail service running', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Add account', exact: true }).click();
    await page.getByLabel('Email address').fill('alice@mailgrid.test');
    await page.getByLabel('Password', { exact: false }).fill('a');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Compose email', exact: true }).click();
    await page.getByLabel('To', { exact: true }).fill('anyone@example.test');
    await page.getByLabel('Subject', { exact: true }).fill('Desktop receipt');
    await page.getByLabel('Message', { exact: true }).fill('A local message from the desktop test.');
    await page.getByRole('button', { name: 'Send locally', exact: true }).click();
    await page.getByRole('button', { name: 'Catch-all inbox', exact: true }).click();
    await page.getByRole('button', { name: /Desktop receipt/ }).click();
    await page.getByText('A local message from the desktop test.', { exact: true }).waitFor();
    await page.getByLabel('Search messages').fill('no such subject');
    await page.getByText('No matching mail', { exact: true }).waitFor();
    await page.getByLabel('Search messages').fill('');

    await page.evaluate(async () => window.mailgrid.request('compose.send', {
      from: 'alice@mailgrid.test', to: ['anyone@example.test'], subject: 'Safe HTML preview', text: 'HTML test',
      html: '<h1>Your local email workspace</h1><p>This message stays on this computer.</p><script>window.__executed=true</script><img src="https://example.invalid/track"><a href="https://example.invalid">Link</a>',
    }));
    await page.getByRole('button', { name: /Safe HTML preview/ }).click();
    const frame = page.frameLocator('iframe[title="Safe email preview"]');
    await frame.getByRole('heading', { name: 'Your local email workspace' }).waitFor();
    const isolation = await page.locator('iframe').evaluate((node) => ({ sandbox: node.getAttribute('sandbox'), srcdoc: node.getAttribute('srcdoc') }));
    assert.equal(isolation.sandbox, 'allow-popups');
    assert(!isolation.srcdoc.includes('<script>'));
    assert(!isolation.srcdoc.includes('src="https://'));
    assert(isolation.srcdoc.includes('href="https://example.invalid/"'));

    blocker = await listen();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('SMTP port', { exact: true }).fill(String(blocker.address().port));
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('button', { name: 'Restart now', exact: true }).click();
    await page.getByText('Mail service offline', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('SMTP port', { exact: true }).fill(String(await freePort()));
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await page.getByRole('button', { name: 'Restart now', exact: true }).click();
    await page.getByText('Mail service running', { exact: true }).waitFor();
    await page.getByRole('button', { name: /Safe HTML preview/ }).waitFor();
    await frame.getByRole('heading', { name: 'Your local email workspace' }).waitFor();

    mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results', 'desktop.png') });
    assert.deepEqual(errors, []);
    console.log('PASS: account creation, compose, live refresh, inspection, search, safe HTML, port-conflict recovery, restart');
  } finally {
    if (blocker) await new Promise((resolve) => blocker.close(resolve));
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

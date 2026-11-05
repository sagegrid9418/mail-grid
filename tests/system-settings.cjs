const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../dist-electron/system-settings.js'), 'utf8');
function adapter(platform, desktop = '', fail = false) {
 const calls = [], target = { exports: {} };
 const electron = { shell: { openExternal: async url => calls.push(url) } };
 const childProcess = { spawn: (command, args, options) => {
  calls.push({ command, args, options }); const child = new EventEmitter(); child.unref = () => {};
  setImmediate(() => fail ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')); return child;
 } };
 new Function('require', 'module', 'exports', 'process', source)(name => name === 'electron' ? electron : name === 'node:child_process' ? childProcess : require(name), target, target.exports, { platform, env: { XDG_CURRENT_DESKTOP: desktop } });
 return { calls, open: target.exports.openSystemSettings };
}
(async () => {
 for (const [platform, expected] of [['darwin', ['x-apple.systempreferences:com.apple.preference.notifications', 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension', 'x-apple.systempreferences:com.apple.preference.security?Privacy']], ['win32', ['ms-settings:notifications', 'ms-settings:startupapps', 'ms-settings:privacy']]]) {
  const service = adapter(platform); for (const key of ['notifications', 'startup', 'privacy']) await service.open(key);
  assert.deepEqual(service.calls, expected); await assert.rejects(() => service.open('file:///tmp/private')); assert.equal(service.calls.length, 3);
 }
 const gnome = adapter('linux', 'GNOME'); await gnome.open('notifications'); await gnome.open('startup');
 assert.equal(gnome.calls[0].command, 'gnome-control-center'); assert.deepEqual(gnome.calls[0].args, ['notifications']);
 assert.equal(gnome.calls[1].command, 'gnome-session-properties'); assert.deepEqual(gnome.calls[1].args, []);
 const kde = adapter('linux', 'KDE'); await kde.open('startup'); assert.equal(kde.calls[0].command, 'systemsettings'); assert.deepEqual(kde.calls[0].args, ['kcm_autostart']);
 await assert.rejects(() => adapter('linux', '', true).open('privacy'), /Open your desktop/);
 console.log('PASS: fixed system-settings routes, desktop commands, invalid target rejection, unavailable-tool guidance');
})().catch(error => { console.error(error); process.exitCode = 1; });

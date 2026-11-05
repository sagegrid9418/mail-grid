const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const source = fs.readFileSync(path.join(__dirname, '../dist-electron/unread-badge.js'), 'utf8');
function load(platform) {
 const calls = [], target = { exports: {} };
 const electron = { app: { setBadgeCount: count => { calls.push(count); return true; } }, nativeImage: { createFromBuffer: buffer => buffer } };
 new Function('require', 'module', 'exports', 'process', source)(name => name === 'electron' ? electron : require(name), target, target.exports, { platform });
 return { ...target.exports, calls };
}
for (const platform of ['darwin', 'linux', 'win32']) {
 const service = load(platform), overlays = [], tips = [];
 const window = { setOverlayIcon: (image, description) => overlays.push({ image, description }) }, tray = { setToolTip: tip => tips.push(tip) };
 service.showUnreadBadge(13, window, tray); service.showUnreadBadge(0, window, tray);
 if (platform === 'win32') { assert(Buffer.isBuffer(overlays[0].image)); assert.equal(overlays[0].description, '13 unread emails'); assert.equal(overlays[1].image, null); }
 else assert.deepEqual(service.calls, [13, 0]);
 assert.equal(tips[0], 'Mail Grid — 13 unread emails'); assert.equal(tips[1], 'Mail Grid');
 for (const count of [1, 9, 10, 99, 100, 20000]) {
  const png = service.badgePNG(count); assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 32); assert.equal(png.readUInt32BE(20), 32);
  let offset = 8; const payloads = [];
  while (offset < png.length) { const size = png.readUInt32BE(offset); if (png.subarray(offset + 4, offset + 8).toString() === 'IDAT') payloads.push(png.subarray(offset + 8, offset + 8 + size)); offset += 12 + size; }
  assert.equal(zlib.inflateSync(Buffer.concat(payloads)).length, 32 * (1 + 32 * 4));
 }
}
console.log('PASS: macOS/Linux count dispatch, Windows numeric overlay PNGs, clearing and tray descriptions');

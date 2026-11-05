import { app, nativeImage, type BrowserWindow, type Tray } from 'electron';
import { deflateSync } from 'node:zlib';

// Small PNG renderer for the Windows taskbar overlay; no renderer privileges needed.
const digits: Record<string, string[]> = {
  '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
  '2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
  '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
  '6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
  '8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
  '+': ['000','010','111','010','000'],
};
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([size, payload, crc]);
}
export function badgePNG(count: number) {
  const pixels = Buffer.alloc(32 * 32 * 4);
  const paint = (x: number, y: number, color: number[]) => pixels.set(color, (y * 32 + x) * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if ((x - 15.5) ** 2 + (y - 15.5) ** 2 < 15.5 ** 2) paint(x, y, [218, 52, 68, 255]);
  const text = count > 99 ? '99+' : String(count), scale = text.length > 2 ? 2 : 3;
  const left = Math.floor((32 - (text.length * 4 - 1) * scale) / 2), top = Math.floor((32 - 5 * scale) / 2);
  [...text].forEach((digit, index) => digits[digit].forEach((row, y) => [...row].forEach((value, x) => {
    if (value === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) paint(left + (index * 4 + x) * scale + dx, top + y * scale + dy, [255, 255, 255, 255]);
  })));
  const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.concat(Array.from({ length: 32 }, (_, y) => Buffer.concat([Buffer.from([0]), pixels.subarray(y * 128, (y + 1) * 128)])));
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
export function showUnreadBadge(count: number, window: BrowserWindow | null, tray: Tray | null) {
  const unread = Math.max(0, Math.trunc(count));
  if (process.platform === 'win32') window?.setOverlayIcon(unread ? nativeImage.createFromBuffer(badgePNG(unread)) : null, unread ? `${unread} unread emails` : 'No unread emails');
  else app.setBadgeCount(unread);
  tray?.setToolTip(unread ? `Mail Grid — ${unread} unread ${unread === 1 ? 'email' : 'emails'}` : 'Mail Grid');
}

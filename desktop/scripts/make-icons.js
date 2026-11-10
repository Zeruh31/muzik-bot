'use strict';

// Renders build/icon.svg into the PNG and ICO files the app and the installer use:
//   assets/icon.png  256 px  window icon and in-app logo
//   assets/tray.png   32 px  system tray
//   build/icon.png   512 px  electron-builder
//   build/icon.ico   16-256  exe, installer and shortcuts (PNG-compressed entries)
// Usage: npm run icons

const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'));

function png(size) {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
}

/** ICO container with PNG images (supported by Windows Vista and later). */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), png(256));
fs.writeFileSync(path.join(root, 'assets', 'tray.png'), png(32));
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png(512));
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256]));
console.log('Simgeler üretildi: assets/icon.png, assets/tray.png, build/icon.png, build/icon.ico');

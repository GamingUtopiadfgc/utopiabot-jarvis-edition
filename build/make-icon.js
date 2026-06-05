'use strict';

// Wrap build/icon.png (256x256) into a valid Windows build/icon.ico.
// Modern .ico supports a PNG-compressed entry, so we embed the PNG directly.
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const png = fs.readFileSync(path.join(dir, 'icon.png'));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type 1 = icon
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width  (0 => 256)
entry.writeUInt8(0, 1); // height (0 => 256)
entry.writeUInt8(0, 2); // palette
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // image size
entry.writeUInt32LE(6 + 16, 12); // offset to image data

fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, entry, png]));
console.log(`icon.ico written (${png.length} bytes of PNG embedded)`);

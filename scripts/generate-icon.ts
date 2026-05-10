/**
 * Generates public/favicon.ico — a 16x16 audio fader icon.
 *
 * ICO format: ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + DIB image data.
 * DIB format: BITMAPINFOHEADER (40 bytes) + BGRA pixel rows (bottom-up).
 *
 * Icon design: blue background with a simple single-fader mixer layout:
 *   - Thin vertical track (dark) in the center
 *   - Horizontal thumb (white) ~60% from the top
 */

import fs from 'fs';
import path from 'path';

const W = 16;
const H = 16;

// BGRA colours — #0057A6 blue background
const BLUE  = [0xa6, 0x57, 0x00, 0xff] as const;
const TRACK = [0x20, 0x30, 0x40, 0xff] as const; // dark navy track
const THUMB = [0xff, 0xff, 0xff, 0xff] as const; // white thumb

// Build pixel grid (row 0 = top)
const pixels: number[][] = Array.from({ length: H }, () =>
  Array.from({ length: W * 4 }, () => 0)
);

function setPixel(x: number, y: number, bgra: readonly [number, number, number, number]): void {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = x * 4;
  pixels[y][i]     = bgra[0];
  pixels[y][i + 1] = bgra[1];
  pixels[y][i + 2] = bgra[2];
  pixels[y][i + 3] = bgra[3];
}

function fillRect(x: number, y: number, w: number, h: number, bgra: readonly [number, number, number, number]): void {
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++)
      setPixel(x + dx, y + dy, bgra);
}

// Background
fillRect(0, 0, W, H, BLUE);

// Single fader: vertical track (1 px wide) at x=7, from y=2 to y=13
fillRect(7, 2, 2, 12, TRACK);

// Horizontal thumb (4 px wide, 3 px tall) centred on x=7, at y=8
fillRect(4, 7, 8, 3, THUMB);

// Build DIB: pixel data is bottom-up in ICO/BMP format
const rowBytes = W * 4;
const pixelData = Buffer.alloc(rowBytes * H);
for (let row = 0; row < H; row++) {
  const srcRow = pixels[H - 1 - row]; // flip vertically
  for (let i = 0; i < rowBytes; i++) {
    pixelData[row * rowBytes + i] = srcRow[i];
  }
}

// BITMAPINFOHEADER (40 bytes)
const dibHeader = Buffer.alloc(40);
dibHeader.writeUInt32LE(40, 0);       // biSize
dibHeader.writeInt32LE(W, 4);         // biWidth
dibHeader.writeInt32LE(H * 2, 8);     // biHeight (doubled — ICO convention: includes AND mask height)
dibHeader.writeUInt16LE(1, 12);       // biPlanes
dibHeader.writeUInt16LE(32, 14);      // biBitCount (32-bit BGRA)
dibHeader.writeUInt32LE(0, 16);       // biCompression (BI_RGB)
dibHeader.writeUInt32LE(pixelData.length, 20); // biSizeImage
dibHeader.writeInt32LE(0, 24);        // biXPelsPerMeter
dibHeader.writeInt32LE(0, 28);        // biYPelsPerMeter
dibHeader.writeUInt32LE(0, 32);       // biClrUsed
dibHeader.writeUInt32LE(0, 36);       // biClrImportant

// AND mask (1 bit per pixel, all zeros = fully opaque), padded to 4-byte rows
const andRowBytes = Math.ceil(W / 8);
const andPadded   = Math.ceil(andRowBytes / 4) * 4;
const andMask     = Buffer.alloc(andPadded * H, 0);

const imageData = Buffer.concat([dibHeader, pixelData, andMask]);

// ICONDIRENTRY (16 bytes)
const entry = Buffer.alloc(16);
entry.writeUInt8(W, 0);                        // width
entry.writeUInt8(H, 1);                        // height
entry.writeUInt8(0, 2);                        // colour count (0 = no palette)
entry.writeUInt8(0, 3);                        // reserved
entry.writeUInt16LE(1, 4);                     // planes
entry.writeUInt16LE(32, 6);                    // bit count
entry.writeUInt32LE(imageData.length, 8);      // size of image data
entry.writeUInt32LE(6 + 16, 12);               // offset of image data (after ICONDIR + 1 entry)

// ICONDIR (6 bytes)
const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0);   // reserved
iconDir.writeUInt16LE(1, 2);   // type (1 = icon)
iconDir.writeUInt16LE(1, 4);   // count of images

const ico = Buffer.concat([iconDir, entry, imageData]);

const outPath = path.join(import.meta.dir, '..', 'public', 'favicon.ico');
fs.writeFileSync(outPath, ico);
console.log(`Icon written → ${outPath} (${ico.length} bytes)`);

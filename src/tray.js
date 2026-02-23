'use strict';

const { exec } = require('child_process');

// Build a minimal 16x16 32-bit ICO in memory so no image file needs to be shipped.
function buildIcon() {
  const w = 16, h = 16;

  // BITMAPINFOHEADER (40 bytes)
  const bih = Buffer.alloc(40);
  bih.writeUInt32LE(40, 0);       // biSize
  bih.writeInt32LE(w, 4);         // biWidth
  bih.writeInt32LE(h * 2, 8);     // biHeight (×2 for ICO AND-mask convention)
  bih.writeUInt16LE(1, 12);       // biPlanes
  bih.writeUInt16LE(32, 14);      // biBitCount (32-bit BGRA)

  // Pixel data: 16×16 BGRA, solid blue (#0057A6)
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    px[i * 4 + 0] = 0xA6; // B
    px[i * 4 + 1] = 0x57; // G
    px[i * 4 + 2] = 0x00; // R
    px[i * 4 + 3] = 0xFF; // A
  }

  // AND mask — one bit per pixel, DWORD-aligned rows, all zeros (fully opaque)
  const andMask = Buffer.alloc(Math.ceil(w / 32) * 4 * h, 0);

  const imgData = Buffer.concat([bih, px, andMask]);

  // ICO file header
  const icoHdr = Buffer.from([0, 0, 1, 0, 1, 0]);

  // ICO directory entry (16 bytes)
  const dir = Buffer.alloc(16);
  dir[0] = w;
  dir[1] = h;
  dir.writeUInt16LE(1, 4);               // planes
  dir.writeUInt16LE(32, 6);              // bitCount
  dir.writeUInt32LE(imgData.length, 8);  // size of image data
  dir.writeUInt32LE(22, 12);             // offset (6 header + 16 dir = 22)

  return Buffer.concat([icoHdr, dir, imgData]).toString('base64');
}

const ICON = buildIcon();

// Menu item indices (no separators — systray has no standard separator API)
const MENU = {
  STATUS:       0,  // disabled status-display item, updated on state changes
  OPEN_BROWSER: 1,
  EXIT:         2,
};

function startTray(port, state) {
  if (process.platform !== 'win32') return;

  let SysTray;
  try {
    SysTray = require('systray').default;
  } catch (e) {
    console.warn('[Tray] systray module not available:', e.message);
    return;
  }

  const tray = new SysTray({
    menu: {
      icon: ICON,
      title: '',
      tooltip: 'service-remote',
      items: [
        { title: 'OBS:off  X32:off  MIDI:off', tooltip: 'Connection status', checked: false, enabled: false },
        { title: 'Open in Browser', tooltip: '', checked: false, enabled: true },
        { title: 'Exit', tooltip: '', checked: false, enabled: true },
      ],
    },
    copyDir: true,  // cache the tray binary in the user profile on first run
    debug: false,
  });

  tray.onError(err => console.warn('[Tray] error:', err.message));

  tray.onClick(action => {
    if (action.seq_id === MENU.OPEN_BROWSER) {
      exec(`start http://localhost:${port}`);
    } else if (action.seq_id === MENU.EXIT) {
      tray.kill(); // also calls process.exit(0) once the tray binary exits
    }
  });

  // Update the status item whenever any connection state changes
  state.on('change', ({ state: s }) => {
    const obs  = s.obs.connected      ? 'OBS:on'  : 'OBS:off';
    const x32  = s.x32.connected      ? 'X32:on'  : 'X32:off';
    const midi = s.proclaim.connected ? 'MIDI:on' : 'MIDI:off';
    tray.sendAction({
      type: 'update-item',
      item: { title: `${obs}  ${x32}  ${midi}`, tooltip: 'Connection status', checked: false, enabled: false },
      seq_id: MENU.STATUS,
    });
  });

  // Clean up the tray process if the server exits for any other reason
  process.on('exit', () => {
    if (!tray.killed) tray.kill(false);
  });
}

module.exports = { startTray };

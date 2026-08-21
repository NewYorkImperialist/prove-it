"use strict";
// Generates the PWA / home-screen icons in public/ — the amber target on a near-black plate, once
// for the game and once more with a blue stripe beside the target for the admin dashboard, which
// installs as its own app.
//
// INVERSE of lib/favicon.js and components/ui/Logo.jsx, which are a dark target on a filled amber
// plate. Not drift — an installed icon sits on the user's wallpaper among their other apps, where a
// solid amber square is a bright blob, while the favicon and the in-app badge sit in a tab strip and
// on this app's own dark panels, where the filled plate is what makes the mark findable. Changing
// one of the two does not imply changing the other.
//
// Why a script and not a checked-in binary someone hand-drew: lib/favicon.js is an inline SVG
// data URI, so there was no raster icon anywhere in the repo, and a manifest needs real PNGs at
// stable URLs. Regenerate with `npm run icons` after changing SHAPE or the brand colours.
//
// Why the mark is drawn as geometry rather than as the "◎" character the favicon uses: every
// text-to-PNG path needs a font with that glyph in it. U+25CE lives in Noto Sans Symbols, which
// is not bundled anywhere here, and a missing glyph rasterises to a tofu box — so the ring and
// the dot are drawn as circles instead. Same mark, no font dependency, no surprise at build time.
//
// No image library either: node:zlib can deflate, a PNG is four chunks, and the shape is two
// circles and a rounded rectangle. Antialiasing is 4x4 supersampling per pixel, accumulated
// premultiplied so the transparent margin doesn't leave a dark fringe around the corners.
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const AMBER = [0xf5, 0xa6, 0x23]; // --accent, the mark
const PANEL = [0x14, 0x11, 0x0c]; // --panel, the plate under it
const MONO = [0xff, 0xff, 0xff]; // Android tints the monochrome layer, so only its alpha matters
const DEV = [0x5b, 0x8c, 0xff]; // the admin dashboard's own link blue — see routes/admin.js

// All geometry on a 0..100 canvas, so one set of numbers drives every size.
const SHAPE = {
  plate: { x: 8, y: 8, w: 84, h: 84, r: 20 }, // matches the favicon's <rect rx='20'>
  ring: { cx: 50, cy: 50, outer: 31, inner: 23.5 },
  dot: { cx: 50, cy: 50, r: 11.5 },
};

// The admin dashboard's own icon: same plate and same target, plus a blue stripe beside the mark,
// so the two tiles are not mistaken for each other on a home screen. The whole composition is
// pulled inside the maskable safe zone — a circle of radius 40 about (50,50) — because a launcher
// crops a maskable icon to its own shape, and a stripe out at the plate's edge is the first thing
// a circular mask would cut off. That is why the target shifts right rather than staying centred:
// it makes room for the stripe without either element leaving the safe circle.
const SHAPE_ADMIN = {
  plate: SHAPE.plate,
  stripe: { x: 22, y: 26, w: 8, h: 48, r: 4 },
  ring: { cx: 57, cy: 50, outer: 25, inner: 19 },
  dot: { cx: 57, cy: 50, r: 9 },
};

const dist = (x, y, cx, cy) => Math.hypot(x - cx, y - cy);

// Signed-distance-ish test: is (x,y) inside a rounded rectangle?
function inRoundRect(x, y, { x: rx, y: ry, w, h, r }) {
  const nx = Math.max(rx + r - x, 0, x - (rx + w - r));
  const ny = Math.max(ry + r - y, 0, y - (ry + h - r));
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  return nx * nx + ny * ny <= r * r || (nx === 0 && ny === 0);
}

// The colour at a point, or null for "nothing here".
//
//  • `bleed` fills the whole canvas instead of drawing a plate with a margin — that's what a
//    maskable icon needs, because the launcher crops it to whatever shape the OS uses and a
//    transparent margin would show as a gap.
//  • `mono` drops the plate entirely and returns only the mark. Android 13+ themed icons take
//    the monochrome layer as an alpha mask and tint it with the system palette, so a plate would
//    swallow the whole tile and the RGB it comes back as is irrelevant.
//  • `shape` picks the composition: SHAPE for the game, SHAPE_ADMIN for the dashboard. Only the
//    admin one has a `stripe`, so the stripe test is skipped entirely for the game icon.
function sample(x, y, { bleed = false, mono = false, shape = SHAPE } = {}) {
  const dRing = dist(x, y, shape.ring.cx, shape.ring.cy);
  const onMark =
    (dRing <= shape.ring.outer && dRing >= shape.ring.inner) ||
    dist(x, y, shape.dot.cx, shape.dot.cy) <= shape.dot.r;
  // The stripe joins the mark in the monochrome layer too: it is the only thing telling the two
  // icons apart, and a themed home screen that dropped it would show two identical tiles.
  const onStripe = !!shape.stripe && inRoundRect(x, y, shape.stripe);
  if (mono) return onMark || onStripe ? MONO : null;
  if (!(bleed || inRoundRect(x, y, shape.plate))) return null;
  if (onMark) return AMBER;
  if (onStripe) return DEV;
  return PANEL;
}

const SS = 4; // subsamples per axis

function render(size, opts = {}) {
  const px = Buffer.alloc(size * size * 4);
  const scale = 100 / size;
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxi + (sx + 0.5) / SS) * scale, (py + (sy + 0.5) / SS) * scale, opts);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 255; // premultiplied: misses contribute nothing
        }
      }
      const n = SS * SS;
      const o = (py * size + pxi) * 4;
      if (a === 0) continue; // leave it fully transparent
      const cov = a / (255 * n);
      px[o] = Math.round(r / (a / 255)); // un-premultiply back to straight alpha
      px[o + 1] = Math.round(g / (a / 255));
      px[o + 2] = Math.round(b / (a / 255));
      px[o + 3] = Math.round(cov * 255);
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Each scanline is prefixed with its filter byte; 0 means "none", which deflate handles fine
  // at these sizes and keeps this encoder to one obvious path.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 192 and 512 are what the manifest advertises; Android wants a 512 maskable before it will
// offer the install prompt, and iOS ignores the manifest entirely and reads apple-touch-icon,
// which must be opaque because iOS composites transparency onto black.
//
// The monochrome layer is what Android 13+ uses for themed icons, where the launcher recolours
// every icon to match the wallpaper. Without it the amber plate stays amber on a themed home
// screen and the game is the one tile that ignores the user's setting.
//
// The admin set mirrors it one-for-one, because the dashboard is a separate installed app with a
// separate manifest (routes/admin.js serves it) and the OS needs the same sizes for both.
const OUT = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-maskable-512.png", size: 512, bleed: true },
  { file: "icon-monochrome-512.png", size: 512, mono: true },
  { file: "apple-icon.png", size: 180, bleed: true },
  { file: "admin-icon-192.png", size: 192, shape: SHAPE_ADMIN },
  { file: "admin-icon-512.png", size: 512, shape: SHAPE_ADMIN },
  { file: "admin-icon-maskable-512.png", size: 512, bleed: true, shape: SHAPE_ADMIN },
  { file: "admin-icon-monochrome-512.png", size: 512, mono: true, shape: SHAPE_ADMIN },
  { file: "admin-apple-icon.png", size: 180, bleed: true, shape: SHAPE_ADMIN },
];

const dir = path.join(__dirname, "..", "public");
for (const { file, size, ...opts } of OUT) {
  const buf = png(size, render(size, opts));
  fs.writeFileSync(path.join(dir, file), buf);
  console.log(`${file}  ${size}x${size}  ${buf.length} bytes`);
}

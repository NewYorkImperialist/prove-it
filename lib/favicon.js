"use strict";
// The ◎ badge favicon, inlined as a data URI so there's no extra request and no binary asset to keep
// in sync with the palette. Used by app/layout.jsx and the challenge share-link stub
// (templates/challenge.html renders it through lib/render.js).
//
// Black rings on an orange plate — the original mark, and deliberately NOT the same way round as the
// home-screen icons in public/, which are amber-on-black. A browser tab is the one place the mark
// competes with a strip of other favicons rather than sitting on this app's own dark background, and
// a solid amber square is what picks it out of that strip; an amber ring on near-black at 16px reads
// as a dark smudge next to it. scripts/make-icons.js is the inverse on purpose, so the two are not
// meant to be kept in sync.
//
// The mark is GEOMETRY, not the "◎" character it used to be. A <text> element renders with whatever
// font the browser happens to have, and U+25CE lives in Noto Sans Symbols — bundled nowhere here.
// scripts/make-icons.js has always drawn circles for exactly this reason ("a missing glyph rasterises
// to a tofu box"), and the favicon relying on the glyph meant the two could disagree about what the
// logo even looks like, on a machine nobody testing it happened to be using. Two circles cost the
// same bytes and cannot fail.
//
// The numbers are SHAPE in scripts/make-icons.js, unchanged, so the favicon and the icons are the
// same mark at the same proportions: plate 8,8,84x84 r20; ring outer 31, inner 23.5; dot r 11.5. The
// ring is drawn as a stroke, so its radius is the midline (31+23.5)/2 and its width the difference.
const PLATE = "%23f5a623"; // --accent
const MARK = "%23241500"; // --markfg, the near-black the mark has always been on an amber fill

const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  `<rect x='8' y='8' width='84' height='84' rx='20' fill='${PLATE}'/>` +
  `<circle cx='50' cy='50' r='27.25' fill='none' stroke='${MARK}' stroke-width='7.5'/>` +
  `<circle cx='50' cy='50' r='11.5' fill='${MARK}'/></svg>`;

module.exports = { FAVICON };

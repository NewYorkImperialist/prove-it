"use strict";
// The ◎ badge favicon, inlined as a data URI so there's no extra request and no binary
// asset to keep in sync with the palette. Used by app/layout.jsx and the challenge
// share-link stub (templates/challenge.html renders it through lib/render.js).
//
// Amber target on a near-black plate, matching the home-screen icons in public/. The plate is
// --panel rather than --bg so the tile still reads as a tile against a black browser theme; at
// 16px the amber ring is doing the recognising anyway, which is why the mark is the bright half.
const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  "<rect x='8' y='8' width='84' height='84' rx='20' fill='%2314110c'/>" +
  "<text x='50' y='50' font-size='64' text-anchor='middle' dominant-baseline='central' fill='%23f5a623'>◎</text></svg>";

module.exports = { FAVICON };

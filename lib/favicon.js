"use strict";
// The ◎ badge favicon, inlined as a data URI so there's no extra request and no binary
// asset to keep in sync with the palette. Used by app/layout.jsx and the challenge
// share-link stub (templates/challenge.html renders it through lib/render.js).
//
// Dark target on an amber plate — the original mark, and deliberately NOT the same way round as
// the home-screen icons in public/, which are amber-on-black. A browser tab is the one place the
// mark competes with a strip of other favicons rather than sitting on this app's own dark
// background, and a solid amber square is what picks it out of that strip; an amber ring on
// near-black at 16px reads as a dark smudge next to it. scripts/make-icons.js is the inverse on
// purpose, so the two are not meant to be kept in sync.
const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  "<rect x='8' y='8' width='84' height='84' rx='20' fill='%23f5a623'/>" +
  "<text x='50' y='50' font-size='64' text-anchor='middle' dominant-baseline='central' fill='%23241500'>◎</text></svg>";

module.exports = { FAVICON };

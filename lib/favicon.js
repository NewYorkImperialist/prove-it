"use strict";
// The ◎ badge favicon, inlined as a data URI so there's no extra request and no binary
// asset to keep in sync with the palette. Used by app/layout.jsx and the challenge
// share-link stub (templates/challenge.html renders it through lib/render.js).
const FAVICON =
  "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
  "<rect x='8' y='8' width='84' height='84' rx='20' fill='%23f5a623'/>" +
  "<text x='50' y='50' font-size='64' text-anchor='middle' dominant-baseline='central' fill='%23241500'>◎</text></svg>";

module.exports = { FAVICON };

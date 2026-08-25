"use strict";
// Two secrets, because they were one and that one was kept in a browser.
//
// OWNER_KEY gates every /admin* route: the dashboard, every visitor's IP and geography, all chat,
// the session log, and the write tools that rename, merge and delete leaderboard entries. It must
// never leave the server except into the owner's own address bar.
//
// The 👑 crown is a cosmetic badge on the owner's own scores. To render it, the browser has to hold
// the secret that validates it — lib/browser/storage.js keeps it in localStorage and every result
// POST and setCrown socket emit carries it. That is fine for a badge and completely unacceptable for
// the admin key, and until now they were THE SAME VALUE. Enabling the crown once on any shared or
// borrowed device, or a single XSS anywhere in the app, handed over the whole dashboard.
//
// So: CROWN_KEY is the browser-resident one, OWNER_KEY stays server-side. If CROWN_KEY is unset the
// crown falls back to OWNER_KEY, because that is what every already-installed browser is holding —
// setting CROWN_KEY to a fresh value is what completes the split, and until then nothing breaks.
// Once it is set, an old browser's stored key stops crowning, which is the intended outcome: the
// value that leaked is no longer good for anything.
const crypto = require("node:crypto");

// Constant-time compare that can't throw or leak length. Both keys are compared this way — a
// timing oracle on the admin key is worth more to an attacker than one on the crown.
function secretEq(want, got) {
  if (!want || typeof got !== "string" || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

// Gate for every /admin* route — OWNER_KEY only, never the crown key.
function ownerOk(req) {
  const key = req.query.key || req.get("x-owner-key");
  return secretEq(process.env.OWNER_KEY, typeof key === "string" ? key : "");
}

// Does this client-supplied key earn the cosmetic 👑? CROWN_KEY when set, otherwise OWNER_KEY.
function crownOk(key) {
  const want = process.env.CROWN_KEY || process.env.OWNER_KEY;
  return secretEq(want, typeof key === "string" ? key : "");
}

// OWNER_KEY for the places that have a bare key rather than a request: the ghostWatch socket emit,
// and the bulk "rename every crowned row" branch. Both are owner capabilities that reach beyond a
// badge, so neither may fall back to the browser-resident crown key.
function ownerKeyOk(key) {
  return secretEq(process.env.OWNER_KEY, typeof key === "string" ? key : "");
}

module.exports = { ownerOk, crownOk, ownerKeyOk };

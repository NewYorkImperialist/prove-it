"use strict";
// Answer matching for solo / daily runs. Solo is judged entirely on the client (there's no
// opponent and no server round-trip per guess), so this is the solo counterpart to the
// server's lib/answer-matching.js. Pure functions — no DOM, no state.

// Case-, space- and accent-insensitive form used for every comparison.
function norm(s) {
  return String(s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// Levenshtein edit distance over short strings, with an early-out once it can't be ≤ 2.
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 3;
  let prev = [];
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    prev = cur;
  }
  return prev[n];
}

// Is the guess a near-miss of some answer? "spell" = a typo (small edit distance),
// "specific" = a prefix of a longer answer (not specific enough). Returns
// { entry, kind } so the caller can nudge the player, or null for a real miss.
function nearMiss(nq, cat) {
  if (nq.length < 3) return null;
  let best = null;
  for (const e of cat.entries) {
    for (const a of e.aliases) {
      if (a === nq) continue;
      const maxD = a.length <= 5 ? 1 : 2;
      if (Math.abs(a.length - nq.length) <= maxD) {
        const d = editDistance(nq, a);
        if (d > 0 && d <= maxD && (!best || best.kind === "specific" || d < best.d)) best = { entry: e, kind: "spell", d };
      }
      if (!best && a.length > nq.length && nq.length >= 4 && a.startsWith(nq)) best = { entry: e, kind: "specific", d: 9 };
    }
  }
  return best;
}

// Exact hit on any alias of any entry (the aliases are pre-normalised by buildCat).
const findEntry = (cat, nq) => cat.entries.find((e) => e.aliases.includes(nq)) || null;

module.exports = { norm, editDistance, nearMiss, findEntry };

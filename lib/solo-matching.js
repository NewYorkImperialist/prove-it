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

// norm() keeps punctuation, so "Kareem Abdul Jabbar" never equalled "Kareem Abdul-Jabbar" and
// instead landed one edit away — i.e. straight into nearMiss's "almost, check your spelling" loop,
// which you can't get out of because the spelling was already right. Same for "John F Kennedy",
// "Cross Country Skiing", "Georges St Pierre" and ~200 others.
//
// It can't just be folded into norm(), though: "C", "C++" and "C#" are three separate answers in
// Programming Languages, and so are Objective-C and Objective-C++. Stripping punctuation from the
// key would merge them and make the ones behind the collision unwinnable — a worse bug than the
// one being fixed. So this stays a FALLBACK, applied only when it lands on exactly one entry.
// Spaces go too, not just the punctuation: dropping the hyphen from "abdul-jabbar" would
// otherwise leave "abduljabbar", which still isn't what "abdul jabbar" types out to.
const punctKey = (s) => norm(s).replace(/[^a-z0-9]+/g, "");

// The punctuation a guess DID type, as a sorted string: "c++" → "++", "b+tree" → "+". Used only to
// break a tie between answers that are identical once punctuation is stripped, which is exactly
// how C / C++ / C# and B-Tree / B+ Tree differ — so "C++" and "B+Tree" still land on the right one
// instead of being thrown out as ambiguous.
const punctMarks = (s) => (norm(s).match(/[^a-z0-9 ]/g) || []).sort().join("");

// Exact hit on any alias of any entry (the aliases are pre-normalised by buildCat), then the
// punctuation-insensitive retry. Still ambiguous → null, so the caller's near-miss path runs.
function findEntry(cat, nq) {
  const exact = cat.entries.find((e) => e.aliases.includes(nq));
  if (exact) return exact;
  const key = punctKey(nq);
  if (!key) return null;
  const hits = cat.entries.filter((e) => e.aliases.some((a) => punctKey(a) === key));
  if (hits.length === 1) return hits[0];
  if (!hits.length) return null;
  const marks = punctMarks(nq);
  const exactMarks = hits.filter((e) => e.aliases.some((a) => punctKey(a) === key && punctMarks(a) === marks));
  return exactMarks.length === 1 ? exactMarks[0] : null;
}

module.exports = { norm, punctKey, editDistance, nearMiss, findEntry };

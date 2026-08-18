"use strict";
// Turning raw challenge results into one row per player.
//
// A challenge board can hold several runs by the same person (they replay, or come back on
// another device). We collapse to their best. On top of that, EVERY crowned row and any row
// sharing the creator's name merge into a single crowned creator entry, so all the creator's
// runs read as one "jayden 👑" instead of a wall of near-duplicates.

const nn = (s) => String(s || "").trim().toLowerCase();

function collapseResults(data) {
  const results = data.results || [];
  let creatorName = data.creator ? nn(data.creator) : null;
  let creatorDisplay = data.creator || null;
  // A crowned row on this board wins the display name.
  for (const r of results) if (r.crown) { creatorName = nn(r.name); creatorDisplay = r.name; }

  const best = new Map();
  for (const r of results) {
    const isCreator = !!r.crown || (creatorName && nn(r.name) === creatorName);
    const key = isCreator ? "__creator__" : r.visitor_id || "name:" + r.name;
    const prev = best.get(key);
    if (!prev || r.total >= prev.total) best.set(key, isCreator ? { ...r, name: creatorDisplay || r.name, crown: 1 } : r);
  }
  return [...best.values()].sort((a, b) => b.total - a.total);
}

// Per-round column maxima, so the best score in each round can be highlighted.
const columnMax = (players, nRounds, pick) =>
  Array.from({ length: nRounds }, (_, i) => Math.max(0, ...players.map((p) => (pick(p)[i] || 0))));

const scoresOf = (p) => p.scores || [];
const wpmsOf = (p) => (Array.isArray(p.wpms) ? p.wpms : []);

function avgWpm(p) {
  const w = wpmsOf(p).filter((n) => n > 0);
  return w.length ? Math.round(w.reduce((a, n) => a + n, 0) / w.length) : 0;
}

module.exports = { collapseResults, columnMax, scoresOf, wpmsOf, avgWpm };

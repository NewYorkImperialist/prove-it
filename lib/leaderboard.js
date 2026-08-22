"use strict";
// Turning raw challenge results into one row per player.
//
// A challenge board can hold several runs by the same person (they replay, or come back on
// another device). We collapse to their best. Every crowned row also merges into a single crowned
// creator entry, so the creator's runs read as one "jayden 👑" rather than a wall of near-duplicates.
//
// Crowned rows only — NOT rows that merely share the creator's name. Name matching meant anyone
// could type the creator's name, post a score, and have it rendered as the creator's own crowned
// entry. The crown is server-validated against OWNER_KEY (routes/challenge.js), so it is the only
// trustworthy signal here. Cost of the change: a creator playing on a device without their owner
// key shows as a separate ordinary row, which is the right trade against impersonation.

function collapseResults(data) {
  const results = data.results || [];
  let creatorDisplay = data.creator || null;
  // A crowned row on this board wins the display name. We no longer keep a lowercased copy to
  // match other rows against — that comparison was the impersonation path described above.
  for (const r of results) if (r.crown) creatorDisplay = r.name;

  const best = new Map();
  for (const r of results) {
    const isCreator = !!r.crown;
    // vkey is an opaque per-response token standing in for the visitor id, which the server no
    // longer publishes. It only has to be stable within one response, which is all this needs.
    //
    // Paired with the name, matching collapseBoard/geoGoat in server/stats.js — the three must not
    // drift or a board disagrees with itself about who someone is. On vkey alone, a row submitted
    // under another player's visitor id replaced that player's entry (POST /result cannot verify the
    // id it is handed); with the name in the key it can only appear alongside them.
    const key = isCreator ? "__creator__" : `${r.vkey || ""} ${String(r.name == null ? "" : r.name).trim().toLowerCase()}`;
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

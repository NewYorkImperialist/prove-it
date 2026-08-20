"use strict";
// The Geography screen's shape: the 27 board categories arranged as MODE × REGION rather than one
// flat 27-item dropdown.
//
// Why this file exists: "Geography Challenge" used to be a second dropdown on the solo builder,
// sitting directly under the 282-category "Pick a category" one and running the identical code
// path (startGeoChallenge was literally startSolo([cat], recommendedTime(cat), true)). Picking the
// group by name also dragged in the group's plain typing lists — Major Rivers, Deserts, Seas and
// Oceans — which have nothing to draw. Every board falls into exactly one of four modes, and every
// mode covers a set of regions, so that's what the screen offers.
//
// Pure data + pure functions: no DOM, no React, so the arrangement is testable without a browser.
const { CATS, FLAG_CATS, recommendedTime } = require("./solo-catalog.js");
const { geoMode } = require("./geo-cats.js");

// Order matters: a Borders quiz is geoMode()-"map" too (it draws on the same atlas), and a Flags
// quiz mirrors a "Countries in ..." category, so the quiz flags have to be checked first.
function modeOf(cat) {
  if (cat.isFlagQuiz) return "flags";
  if (cat.isBorderQuiz) return "borders";
  if (geoMode(cat.name) === "fill") return "capitals";
  if (geoMode(cat.name) === "map") return "map";
  return null;
}

const MODES = [
  { key: "map", emoji: "🗺️", label: "Name the map", blurb: "Blank outlines — name every country you can find." },
  { key: "flags", emoji: "🚩", label: "Flags", blurb: "A grid of flags. Name the country each one belongs to." },
  { key: "borders", emoji: "🧩", label: "Borders", blurb: "One country highlighted at a time. Name it." },
  { key: "capitals", emoji: "🏛️", label: "Capitals", blurb: "Every country listed — type each one's capital city." },
];

// "Flags of Europe" and "Countries in Europe" are the same region in two modes, so the region list
// under a mode shouldn't repeat the mode's own name back at you.
const REGION_OVERRIDES = {
  "Countries of the World": "World",
  "Flags of the World": "World",
  "Borders of the World": "World",
  "World Capitals": "World",
  "US States": "United States",
  "US State Capitals": "United States",
  "European Union Members": "EU members",
  "Countries in the Middle East": "Middle East",
};
function regionLabel(catName) {
  if (REGION_OVERRIDES[catName]) return REGION_OVERRIDES[catName];
  return catName
    .replace(/^Countries in (the )?/, "")
    .replace(/^Countries of (the )?/, "")
    .replace(/^Flags of (the )?/, "")
    .replace(/^Borders of (the )?/, "");
}

// Biggest first inside a mode: the World board is the headline one, and the small regions read as
// warm-ups under it rather than as an alphabetical list you have to scan.
function boardsFor(modeKey) {
  const all = [...CATS, ...FLAG_CATS];
  const seen = new Set();
  const out = [];
  for (const c of all) {
    if (seen.has(c.name) || modeOf(c) !== modeKey) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      region: regionLabel(c.name),
      answers: c.entries.length,
      seconds: recommendedTime(c.name),
    });
  }
  return out.sort((a, b) => b.answers - a.answers);
}

// Every board, flat — for the progress count and for validating a picked board name.
const allBoards = () => MODES.flatMap((m) => boardsFor(m.key).map((b) => ({ ...b, mode: m.key })));

// A shared board link carries the board's name (/challenge.html?geo=<board> bounces to
// /?geo=<board>), so the Geography screen needs to turn that name back into the mode whose list
// contains it. Matched case-insensitively: by the time the name comes back it has been through a
// URL, a share sheet and possibly a crawler. Returns null for anything unknown — including the
// literal "1" that the plain /?geo=1 entry point still uses — and the caller falls back to the
// mode list, which is the right landing place when we can't tell which board was meant.
function findBoard(name) {
  const want = String(name || "").trim().toLowerCase();
  if (!want) return null;
  return allBoards().find((b) => b.name.toLowerCase() === want) || null;
}

module.exports = { MODES, modeOf, regionLabel, boardsFor, allBoards, findBoard };

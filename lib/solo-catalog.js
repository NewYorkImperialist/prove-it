"use strict";
// The category catalogue solo / daily runs play out of: every category flattened into
// { name, group, emoji, entries }, plus the genre list and the "is this a fair sprint?"
// rules. Derived from data/categories.js, so adding content still means editing only
// that file.
const CATEGORY_GROUPS = require("../data/categories.js");
const { norm } = require("./solo-matching.js");
const { hasGeoBoard } = require("./geo-cats.js");
const { flagCodeFor } = require("./flags.js");

// Geography categories without a map/grid (Rivers, Natural Disasters, Cities…) get their
// own pseudo-group, so the ones that DO get a board stay together at the top of the list.
const GEO_MISC = "Geography Misc";

function buildCat(cat, group, emoji) {
  return {
    name: cat.name,
    group,
    emoji,
    entries: cat.items.map((it, id) => {
      const n = Array.isArray(it) ? it : [it];
      return { id, display: n[0], aliases: n.map(norm) };
    }),
  };
}

const CATS = [];
for (const [g, v] of Object.entries(CATEGORY_GROUPS)) {
  if (v.defaultOff) continue; // the Secret group stays out of solo
  for (const c of v.cats) {
    const misc = g === "Geography" && !hasGeoBoard(c.name);
    CATS.push(buildCat(c, misc ? GEO_MISC : g, misc ? "🧭" : v.emoji));
  }
}
// Geography first, then Geography Misc, then everything else in its original order.
const grank = (g) => (g === "Geography" ? 0 : g === GEO_MISC ? 1 : 2);
CATS.sort((a, b) => grank(a.group) - grank(b.group)); // stable → the rest keeps its order

// Flags quizzes: "Flags of the World" plus one per continent, sharing the exact same country
// lists (and aliases) as their "Countries in ..." counterparts — just answered by recognizing
// the flag instead of recalling the name from nothing (see components/solo/FlagBoard.jsx).
// Kept in their own array rather than pushed into CATS, so they never show up in the generic
// category picker or get swept into Quick Play / genre mode by accident; findCat() below still
// resolves them (needed to replay a run from its stored category name).
const FLAG_SOURCE = [
  ["Countries of the World", "Flags of the World"],
  ["Countries in Africa", "Flags of Africa"],
  ["Countries in Asia", "Flags of Asia"],
  ["Countries in Europe", "Flags of Europe"],
  ["Countries in North America", "Flags of North America"],
  ["Countries in South America", "Flags of South America"],
  ["Countries in Oceania", "Flags of Oceania"],
];
const FLAG_CATS = FLAG_SOURCE.map(([baseName, flagName]) => {
  const base = CATS.find((c) => c.name === baseName);
  const entries = base.entries.map((e) => ({ ...e, flagCode: flagCodeFor(e) })).filter((e) => e.flagCode);
  return { name: flagName, group: "Flags", emoji: "🚩", entries, isFlagQuiz: true };
});

const GENRES = [];
{
  const seen = new Set();
  for (const c of CATS) if (!seen.has(c.group)) { seen.add(c.group); GENRES.push(c.group); }
}
const GENRE_EMOJI = {};
for (const c of CATS) if (!GENRE_EMOJI[c.group]) GENRE_EMOJI[c.group] = c.emoji;

const findCat = (name) => CATS.find((c) => c.name === name) || FLAG_CATS.find((c) => c.name === name) || null;

// Troll / too-small categories make bad sprints → flagged "non-sprint": excluded from
// genre mode, still allowed if you pick them by hand in custom rounds.
const TROLL = new Set([
  "Things the Nyan Cat Says", "Counting Numbers", "Nobel Peace Prize Loser",
  "People in the Epstein Files", "Italian Brainrot", "Cities Mistaken for Australia's Capital",
  "Seasons of the Year", "Months of the Year",
]);
const nonSprint = (cat) => TROLL.has(cat.name) || cat.entries.length < 12;

// Default seconds per round for the big enumerations; everything else stays at 45s.
const RECOMMENDED_TIME = {
  "Countries of the World": 900, "World Capitals": 900,
  "US States": 240, "US State Capitals": 240, "Major American Cities": 240,
  "Countries in Europe": 300, "Countries in Asia": 300, "Countries in Africa": 360,
  "Countries in North America": 240, "European Union Members": 240, "Languages of the World": 180,
  "Countries in South America": 120, "Countries in Oceania": 150, "Countries in Central America": 90,
  "Countries in the Middle East": 180,
  "Flags of the World": 900, "Flags of Europe": 300, "Flags of Asia": 300, "Flags of Africa": 360,
  "Flags of North America": 240, "Flags of South America": 120, "Flags of Oceania": 150,
};
const recommendedTime = (name) => RECOMMENDED_TIME[name] || 45;

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// n categories from one genre, repeat-filling if the genre is smaller than n.
function pickGenreRounds(genre, n) {
  let pool = shuffle(CATS.filter((c) => c.group === genre && !nonSprint(c)));
  if (!pool.length) pool = shuffle(CATS.filter((c) => c.group === genre));
  const out = [];
  while (out.length < n && pool.length) out.push(...pool);
  return out.slice(0, n).map((c) => c.name);
}

// Categories with a geography board or a flags quiz — the ones with a per-category leaderboard.
const geoBoardCats = () => [...CATS.filter((c) => hasGeoBoard(c.name)), ...FLAG_CATS].map((c) => c.name);

// The exact pool startGeoChallenge() picks a random category from — exposed so a "play a
// specific one instead" picker offers the same set, in a stable (not shuffled) order.
const geoChallengeCats = () => CATS.filter((c) => c.group === "Geography" && !nonSprint(c)).map((c) => c.name);

// The World-then-continents order Flags quizzes are offered in (FLAG_SOURCE's own order).
const flagQuizCats = () => FLAG_CATS.map((c) => c.name);

module.exports = {
  GEO_MISC, CATS, GENRES, GENRE_EMOJI, findCat, buildCat, nonSprint, TROLL,
  RECOMMENDED_TIME, recommendedTime, shuffle, pickGenreRounds, geoBoardCats, geoChallengeCats,
  FLAG_CATS, flagQuizCats,
};

"use strict";
// The category catalogue solo / daily runs play out of: every category flattened into
// { name, group, emoji, entries }, plus the genre list and the "is this a fair sprint?"
// rules. Derived from data/categories.js, so adding content still means editing only
// that file.
const CATEGORY_GROUPS = require("../data/categories.js");
const { norm } = require("./solo-matching.js");
const { hasGeoBoard } = require("./geo-cats.js");

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
  for (const c of v.cats) CATS.push(buildCat(c, g, v.emoji));
}
// Geography first, and inside it the categories that get a map/grid ahead of the ones that
// don't (Rivers, Natural Disasters, Cities…). That ordering used to be done by filing the
// boardless ones under a made-up "Geography Misc" group — but no such group exists in
// data/categories.js, and players were shown it in the genre dropdown and the round header.
const grank = (c) => (c.group === "Geography" ? (hasGeoBoard(c.name) ? 0 : 1) : 2);
CATS.sort((a, b) => grank(a) - grank(b)); // stable → the rest keeps its original order

const GENRES = [];
{
  const seen = new Set();
  for (const c of CATS) if (!seen.has(c.group)) { seen.add(c.group); GENRES.push(c.group); }
}
const GENRE_EMOJI = {};
for (const c of CATS) if (!GENRE_EMOJI[c.group]) GENRE_EMOJI[c.group] = c.emoji;

const findCat = (name) => CATS.find((c) => c.name === name) || null;

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
};
const recommendedTime = (name) => RECOMMENDED_TIME[name] || 45;

// "Quick play" means one short round, so the big enumerations are out of its pool: it used to
// pick any sprintable category and use that category's recommended time, which handed roughly
// one Quick play in twenty a 90s–15:00 round with nothing on the button to warn you.
const QUICK_MAX_SECONDS = 60;
const quickPlayPool = () => CATS.filter((c) => !nonSprint(c) && recommendedTime(c.name) <= QUICK_MAX_SECONDS);

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// The categories a genre can actually field, sprintable ones for preference.
function genrePool(genre) {
  const sprintable = CATS.filter((c) => c.group === genre && !nonSprint(c));
  return sprintable.length ? sprintable : CATS.filter((c) => c.group === genre);
}
// How many rounds a genre can fill without repeating itself — the builder tells you when the
// genre you picked is smaller than the round count you asked for.
const genreRoundLimit = (genre) => genrePool(genre).length;

// Up to n DISTINCT categories from one genre. This used to repeat-fill when the genre had
// fewer categories than rounds, so a 10-round Mythology or Games & Puzzles run replayed a
// category while the builder promised "a random category each round" — a shorter run of
// distinct categories keeps that promise, and the ready screen states the real round count.
function pickGenreRounds(genre, n) {
  return shuffle(genrePool(genre)).slice(0, n).map((c) => c.name);
}

// Categories with a geography board — the only ones with a per-category leaderboard.
const geoBoardCats = () => CATS.filter((c) => hasGeoBoard(c.name)).map((c) => c.name);

module.exports = {
  CATS, GENRES, GENRE_EMOJI, findCat, buildCat, nonSprint, TROLL,
  RECOMMENDED_TIME, recommendedTime, QUICK_MAX_SECONDS, quickPlayPool,
  shuffle, genreRoundLimit, pickGenreRounds, geoBoardCats,
};

"use strict";
// Data derived from categories.js — shared by the room defaults, the admin category-health
// report, and the daily/challenge routes' category validation.
const CATEGORY_GROUPS = require("../data/categories.js");
const { FLAG_SOURCE, FLAG_CAT_NAMES } = require("./flags.js");
const { SILHOUETTE_SOURCE, SILHOUETTE_CAT_NAMES, NO_POLYGON } = require("./silhouettes.js");
const { norm } = require("./solo-matching.js");

const ALL_GROUPS = Object.keys(CATEGORY_GROUPS);
const DEFAULT_GROUPS = ALL_GROUPS.filter((k) => !CATEGORY_GROUPS[k].defaultOff); // Secret starts off
const CAT_SIZES = {}; // category name -> # of answers (for "coverage" / least-explored report)
const CAT_ITEMS = {}; // category name -> [canonical display names] (for the never-named report)
const CAT_GROUP = {}; // category name -> its group
for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) for (const c of grp.cats) {
  CAT_SIZES[c.name] = c.items.length;
  CAT_ITEMS[c.name] = c.items.map((it) => (Array.isArray(it) ? it[0] : it));
  CAT_GROUP[c.name] = gname;
}
const ALL_CAT_NAMES = new Set();
for (const v of Object.values(CATEGORY_GROUPS)) for (const c of v.cats) ALL_CAT_NAMES.add(c.name);

// Flags and Silhouette quizzes (lib/flags.js, lib/silhouettes.js) aren't real categories.js
// entries — they're a client-side layer reusing a "Countries in ..." category's entries — but a
// run still has to name one of them in its rounds array, so the server needs to recognize the
// name too. Mirror the base category's size/items rather than duplicating them out of
// categories.js, and group them as Geography (lib/solo-catalog.js folds them in there too).
for (const [baseName, flagName] of FLAG_SOURCE) {
  CAT_SIZES[flagName] = CAT_SIZES[baseName];
  CAT_ITEMS[flagName] = CAT_ITEMS[baseName];
  CAT_GROUP[flagName] = "Geography";
}
for (const [baseName, silName] of SILHOUETTE_SOURCE) {
  const items = CAT_ITEMS[baseName].filter((it) => !NO_POLYGON.has(norm(it)));
  CAT_SIZES[silName] = items.length;
  CAT_ITEMS[silName] = items;
  CAT_GROUP[silName] = "Geography";
}
// Everything a round is allowed to name: real categories plus the Flags/Silhouette quizzes.
// Kept separate from ALL_CAT_NAMES (which mirrors categories.js exactly) rather than folding
// these into it.
const ALL_ROUND_NAMES = new Set([...ALL_CAT_NAMES, ...FLAG_CAT_NAMES, ...SILHOUETTE_CAT_NAMES]);

module.exports = {
  CATEGORY_GROUPS, ALL_GROUPS, DEFAULT_GROUPS, CAT_SIZES, CAT_ITEMS, CAT_GROUP, ALL_CAT_NAMES,
  ALL_ROUND_NAMES,
};

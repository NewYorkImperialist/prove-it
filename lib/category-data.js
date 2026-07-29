"use strict";
// Data derived from categories.js — shared by the room defaults, the admin category-health
// report, and the daily/challenge routes' category validation.
const CATEGORY_GROUPS = require("../categories.js");

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

module.exports = { CATEGORY_GROUPS, ALL_GROUPS, DEFAULT_GROUPS, CAT_SIZES, CAT_ITEMS, CAT_GROUP, ALL_CAT_NAMES };

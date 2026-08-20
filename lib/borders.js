"use strict";
// Country-outline "Borders" quizzes: World plus one per continent, sharing entries (and
// aliases) with their "Countries in ..." counterpart — same idea as lib/flags.js's Flags
// quizzes, just answered by recognizing the country's shape instead of its flag. The shape
// itself is rendered client-side from the same topojson world atlas the geography map uses
// (lib/browser/border-map.js); this file only decides which entries qualify.
//
// A couple of countries have no drawable polygon in that atlas at this resolution — verified
// directly against cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json rather than guessed —
// so those are dropped instead of shipping a blank tile.
const NO_POLYGON = new Set(["tuvalu", "french guiana"]);

const BORDER_SOURCE = [
  ["Countries of the World", "Borders of the World"],
  ["Countries in Africa", "Borders of Africa"],
  ["Countries in Asia", "Borders of Asia"],
  ["Countries in Europe", "Borders of Europe"],
  ["Countries in North America", "Borders of North America"],
  ["Countries in South America", "Borders of South America"],
  ["Countries in Oceania", "Borders of Oceania"],
];
const BORDER_CAT_NAMES = new Set(BORDER_SOURCE.map(([, name]) => name));

module.exports = { NO_POLYGON, BORDER_SOURCE, BORDER_CAT_NAMES };

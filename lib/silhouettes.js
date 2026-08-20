"use strict";
// Country-outline "Silhouette" quizzes: World plus one per continent, sharing entries (and
// aliases) with their "Countries in ..." counterpart — same idea as lib/flags.js's Flags
// quizzes, just answered by recognizing the country's shape instead of its flag. The shape
// itself is rendered client-side from the same topojson world atlas the geography map uses
// (lib/browser/silhouette-map.js); this file only decides which entries qualify.
//
// A couple of countries have no drawable polygon in that atlas at this resolution — verified
// directly against cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json rather than guessed —
// so those are dropped instead of shipping a blank tile.
const NO_POLYGON = new Set(["tuvalu", "french guiana"]);

const SILHOUETTE_SOURCE = [
  ["Countries of the World", "Silhouettes of the World"],
  ["Countries in Africa", "Silhouettes of Africa"],
  ["Countries in Asia", "Silhouettes of Asia"],
  ["Countries in Europe", "Silhouettes of Europe"],
  ["Countries in North America", "Silhouettes of North America"],
  ["Countries in South America", "Silhouettes of South America"],
  ["Countries in Oceania", "Silhouettes of Oceania"],
];
const SILHOUETTE_CAT_NAMES = new Set(SILHOUETTE_SOURCE.map(([, name]) => name));

module.exports = { NO_POLYGON, SILHOUETTE_SOURCE, SILHOUETTE_CAT_NAMES };

"use strict";
// Which geography categories get a visual board, and of what kind. Split out of the
// browser-only map renderer (lib/browser/geomap.js) so the category catalogue can ask
// "does this get a map?" without pulling D3 into the bundle — and so it stays testable.
//
//  • "map"  → outlined, unlabeled shapes that fill in as you name them.
//  • "fill" → a grid of countries/states; you type each one's capital to fill it.

const WORLD_CATS = new Set([
  "Countries of the World", "Countries in Europe", "Countries in Asia", "Countries in Africa",
  "Countries in South America", "Countries in Oceania", "Countries in North America",
  "Countries in Central America", "European Union Members", "Countries in the Middle East",
]);
const US_CATS = new Set(["US States"]);
const FILL_CATS = { "World Capitals": "world", "US State Capitals": "us" };

// Oceania is zoomed to the Australia/NZ/PNG cluster; the scattered island nations
// become fill-in boxes underneath the map instead of unfindable specks.
const MAP_ONLY = { "Countries in Oceania": new Set(["Australia", "New Zealand", "Papua New Guinea"]) };

function geoMode(catName) {
  if (FILL_CATS[catName]) return "fill";
  if (WORLD_CATS.has(catName) || US_CATS.has(catName)) return "map";
  return null;
}
const hasGeoBoard = (catName) => geoMode(catName) !== null;

module.exports = { WORLD_CATS, US_CATS, FILL_CATS, MAP_ONLY, geoMode, hasGeoBoard };

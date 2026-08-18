"use strict";
// Shared category/answer-matching helpers used by every server-authoritative game mode
// (the "Prove It!" duel in game-engine.js, and the "Challenge Race" mode in race-engine.js).
// Solo/daily mode does its own equivalent client-side (public/app.js) since it isn't
// server-validated — these are the server-side twins of that logic.
const CATEGORY_GROUPS = require("../public/categories.js");

function norm(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}
function buildCategory(cat, group, emoji) {
  return {
    name: cat.name, group, emoji, exact: !!cat.exact,
    entries: cat.items.map((item, id) => {
      const names = Array.isArray(item) ? item : [item];
      return { id, display: names[0], aliases: names.map(norm) };
    }),
  };
}
function resolve(cat, value) {
  const q = norm(value);
  return cat.entries.find((e) => e.aliases.includes(q)) || null;
}
function buildPool(settings) {
  const groups = settings?.groups?.length ? settings.groups : Object.keys(CATEGORY_GROUPS);
  return groups.flatMap((k) =>
    (CATEGORY_GROUPS[k]?.cats || []).map((c) => buildCategory(c, k, CATEGORY_GROUPS[k].emoji)));
}

module.exports = { norm, buildCategory, resolve, buildPool };

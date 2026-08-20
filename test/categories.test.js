"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const CATEGORY_GROUPS = require("../data/categories.js");

// Mirrors game-engine.js's norm() exactly (not exported, so duplicated here) — this is what
// actually decides whether two aliases collide when a player types an answer.
function norm(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

describe("category content structure", () => {
  test("every group has an emoji and a non-empty cats array", () => {
    for (const [name, grp] of Object.entries(CATEGORY_GROUPS)) {
      assert.equal(typeof grp.emoji, "string", `${name}.emoji`);
      assert.ok(Array.isArray(grp.cats) && grp.cats.length > 0, `${name}.cats`);
    }
  });

  test("every category has a non-empty name and a non-empty items array", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        assert.equal(typeof cat.name, "string", `${gname} category name`);
        assert.ok(cat.name.trim().length > 0, `${gname} category name non-empty`);
        assert.ok(Array.isArray(cat.items) && cat.items.length > 0, `${gname}/${cat.name}.items`);
      }
    }
  });

  test("every item is either a non-empty string or a non-empty array of strings", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        for (const item of cat.items) {
          if (Array.isArray(item)) {
            assert.ok(item.length > 0, `${gname}/${cat.name}: empty alias array`);
            for (const alias of item) assert.equal(typeof alias, "string", `${gname}/${cat.name}: non-string alias`);
            assert.ok(item[0].trim().length > 0, `${gname}/${cat.name}: blank canonical name`);
          } else {
            assert.equal(typeof item, "string", `${gname}/${cat.name}: item must be string or array`);
            assert.ok(item.trim().length > 0, `${gname}/${cat.name}: blank item`);
          }
        }
      }
    }
  });

  test("category names are unique across the whole game (beginRound tracks used categories by name)", () => {
    const seen = new Map();
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        const prior = seen.get(cat.name);
        assert.ok(!prior, `category name "${cat.name}" appears in both ${prior} and ${gname}`);
        seen.set(cat.name, gname);
      }
    }
  });

  test("no two different items in the same category normalize to the same alias (would make the second unreachable)", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        const ownerOf = new Map(); // normalized alias -> canonical display name it belongs to
        cat.items.forEach((item) => {
          const names = Array.isArray(item) ? item : [item];
          const display = names[0];
          for (const raw of names) {
            const key = norm(raw);
            const owner = ownerOf.get(key);
            assert.ok(!owner || owner === display,
              `${gname}/${cat.name}: alias "${raw}" (norm "${key}") is claimed by both "${owner}" and "${display}"`);
            ownerOf.set(key, display);
          }
        });
      }
    }
  });

  // The test above only catches an alias claimed by two DIFFERENT canonicals, so a wholly
  // duplicated item passed it: both copies share a display name, so `owner === display` held.
  // A duplicate is worse than unreachable — resolve() returns the first match and answers are
  // deduped by entry id, so the item count overstates what can actually be named and the top
  // claim in the category becomes unwinnable.
  test("no item appears twice in the same category", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        const seen = new Map(); // normalized canonical -> index it first appeared at
        cat.items.forEach((item, i) => {
          const display = Array.isArray(item) ? item[0] : item;
          const key = norm(display);
          const first = seen.get(key);
          assert.equal(first, undefined,
            `${gname}/${cat.name}: "${display}" appears at index ${first} and again at ${i}`);
          seen.set(key, i);
        });
      }
    }
  });

  // An `exact` category makes the game say "There are only N <category>." out loud
  // (game-engine's handleOpen), so N has to be the number of answers that really exist.
  test("an exact category's item count is the number of distinct answers it holds", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        if (!cat.exact) continue;
        const distinct = new Set(cat.items.map((it) => norm(Array.isArray(it) ? it[0] : it)));
        assert.equal(distinct.size, cat.items.length,
          `${gname}/${cat.name} is exact and claims ${cat.items.length}, but only ${distinct.size} answers exist`);
      }
    }
  });

  test("exact categories report a plausible item count (not accidentally empty or a single stray entry)", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        if (cat.exact) assert.ok(cat.items.length >= 2, `${gname}/${cat.name}: exact category with under 2 items looks wrong`);
      }
    }
  });
});

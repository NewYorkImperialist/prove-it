"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const CATEGORY_GROUPS = require("../public/categories.js");

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

  test("exact categories report a plausible item count (not accidentally empty or a single stray entry)", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        if (cat.exact) assert.ok(cat.items.length >= 2, `${gname}/${cat.name}: exact category with under 2 items looks wrong`);
      }
    }
  });
});

"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
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

// solo's norm() (lib/solo-matching.js) keeps "-", "." and "'", so a punctuation-free spelling of a
// punctuated answer is one edit away from it: nearMiss() answers "almost — check your spelling"
// and keeps answering that forever, with the count never moving. The alias is the only cure, and it
// has to exist in EVERY category holding that answer — "guinea bissau" used to be right on
// "Countries in Africa" and an unbreakable near-miss loop on "Countries of the World".
describe("punctuation-free spellings are accepted wherever the answer appears", () => {
  const SPELLINGS = [
    ["Guinea-Bissau", ["guinea bissau"]],
    ["Timor-Leste", ["timor leste"]],
    ["Republic of the Congo", ["congo brazzaville"]],
    ["Democratic Republic of the Congo", ["congo kinshasa"]],
    ["DR Congo", ["congo kinshasa"]],
    ["Ivory Coast", ["cote divoire", "cote d ivoire"]],
    ["Côte d'Ivoire", ["cote divoire", "cote d ivoire"]],
    ["Saint Lucia", ["st lucia", "st. lucia"]],
    ["Saint Kitts and Nevis", ["st kitts", "st. kitts", "st kitts and nevis", "st. kitts and nevis"]],
    ["Saint Vincent and the Grenadines", ["st vincent", "st. vincent", "st vincent and the grenadines", "st. vincent and the grenadines"]],
    ["Saint Paul", ["st paul", "st. paul"]],
  ];

  for (const [display, spellings] of SPELLINGS) {
    test(`"${display}" accepts ${spellings.map((s) => `"${s}"`).join(", ")} in every category it appears in`, () => {
      let seen = 0;
      for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
        for (const cat of grp.cats) {
          const item = cat.items.find((it) => norm(Array.isArray(it) ? it[0] : it) === norm(display));
          if (!item) continue;
          seen++;
          const accepted = new Set((Array.isArray(item) ? item : [item]).map(norm));
          for (const s of spellings) assert.ok(accepted.has(norm(s)), `${gname}/${cat.name}: "${display}" doesn't accept "${s}"`);
        }
      }
      assert.ok(seen > 0, `"${display}" is no longer in the data — drop or rename this row`);
    });
  }
});

// The README quotes these totals twice as a selling point ("N categories, N verified answers").
// Nothing regenerates them, so content grows and the numbers quietly become a lie — this recomputes
// them from the data and holds the README to it.
describe("the README's content figures match the data", () => {
  const README = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const groups = Object.entries(CATEGORY_GROUPS);
  const cats = groups.reduce((n, [, g]) => n + g.cats.length, 0);
  const answers = groups.reduce((n, [, g]) => n + g.cats.reduce((m, c) => m + c.items.length, 0), 0);
  const soloCats = groups.filter(([, g]) => !g.defaultOff).reduce((n, [, g]) => n + g.cats.length, 0);

  const quoted = (re) => {
    const found = [...README.matchAll(re)].map((m) => Number(m[1].replace(/,/g, "")));
    assert.ok(found.length > 0, `the README no longer quotes a figure matching ${re}`);
    return found;
  };

  test("every category count the README quotes is the real one", () => {
    for (const n of quoted(/([\d,]+) categories/g)) assert.equal(n, cats);
  });

  test("every answer count the README quotes is the real one", () => {
    for (const n of quoted(/([\d,]+) verified answers/g)) assert.equal(n, answers);
  });

  test("the group and solo-playable counts the README quotes are the real ones", () => {
    for (const n of quoted(/([\d,]+) themed groups/g)) assert.equal(n, groups.length);
    for (const n of quoted(/([\d,]+) of them playable solo/g)) assert.equal(n, soloCats);
  });
});

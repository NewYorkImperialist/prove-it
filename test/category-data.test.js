"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  CATEGORY_GROUPS, ALL_GROUPS, DEFAULT_GROUPS, CAT_SIZES, CAT_ITEMS, CAT_GROUP, ALL_CAT_NAMES,
  ALL_ROUND_NAMES,
} = require("../lib/category-data.js");
const { FLAG_SOURCE } = require("../lib/flags.js");
const { BORDER_SOURCE, NO_POLYGON } = require("../lib/borders.js");
const { norm } = require("../lib/solo-matching.js");

describe("category-data derivation", () => {
  test("ALL_GROUPS lists every group key", () => {
    assert.deepEqual(new Set(ALL_GROUPS), new Set(Object.keys(CATEGORY_GROUPS)));
  });

  test("DEFAULT_GROUPS excludes every group flagged defaultOff, includes the rest", () => {
    for (const g of ALL_GROUPS) {
      const included = DEFAULT_GROUPS.includes(g);
      assert.equal(included, !CATEGORY_GROUPS[g].defaultOff, `group "${g}"`);
    }
  });

  test("CAT_SIZES/CAT_ITEMS/CAT_GROUP agree with categories.js for every category", () => {
    for (const [gname, grp] of Object.entries(CATEGORY_GROUPS)) {
      for (const cat of grp.cats) {
        assert.equal(CAT_SIZES[cat.name], cat.items.length, `${cat.name} size`);
        assert.equal(CAT_GROUP[cat.name], gname, `${cat.name} group`);
        assert.deepEqual(
          CAT_ITEMS[cat.name],
          cat.items.map((it) => (Array.isArray(it) ? it[0] : it)),
          `${cat.name} canonical items`,
        );
      }
    }
  });

  test("ALL_CAT_NAMES contains exactly every category name across every group", () => {
    const expected = new Set();
    for (const grp of Object.values(CATEGORY_GROUPS)) for (const cat of grp.cats) expected.add(cat.name);
    assert.deepEqual(ALL_CAT_NAMES, expected);
  });

  test("ALL_ROUND_NAMES additionally recognizes every Flags quiz name (regression: POST /challenge used to reject them)", () => {
    for (const [, flagName] of FLAG_SOURCE) {
      assert.equal(ALL_CAT_NAMES.has(flagName), false, `${flagName} shouldn't be a real categories.js entry`);
      assert.equal(ALL_ROUND_NAMES.has(flagName), true, `${flagName} should still be an acceptable round name`);
    }
  });

  test("a Flags quiz mirrors its base category's size, items and gets the Geography group", () => {
    for (const [baseName, flagName] of FLAG_SOURCE) {
      assert.equal(CAT_SIZES[flagName], CAT_SIZES[baseName]);
      assert.deepEqual(CAT_ITEMS[flagName], CAT_ITEMS[baseName]);
      assert.equal(CAT_GROUP[flagName], "Geography");
    }
  });

  test("ALL_ROUND_NAMES additionally recognizes every Border quiz name", () => {
    for (const [, borderName] of BORDER_SOURCE) {
      assert.equal(ALL_CAT_NAMES.has(borderName), false, `${borderName} shouldn't be a real categories.js entry`);
      assert.equal(ALL_ROUND_NAMES.has(borderName), true, `${borderName} should still be an acceptable round name`);
    }
  });

  test("a Border quiz mirrors its base category's items minus the ones with no drawable polygon, and gets the Geography group", () => {
    for (const [baseName, borderName] of BORDER_SOURCE) {
      const expectedItems = CAT_ITEMS[baseName].filter((it) => !NO_POLYGON.has(norm(it)));
      assert.deepEqual(CAT_ITEMS[borderName], expectedItems, borderName);
      assert.equal(CAT_SIZES[borderName], expectedItems.length, borderName);
      assert.equal(CAT_GROUP[borderName], "Geography");
    }
  });
});

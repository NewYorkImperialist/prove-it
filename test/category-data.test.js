"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { CATEGORY_GROUPS, ALL_GROUPS, DEFAULT_GROUPS, CAT_SIZES, CAT_ITEMS, CAT_GROUP, ALL_CAT_NAMES } = require("../lib/category-data.js");

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
});

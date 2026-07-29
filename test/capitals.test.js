"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

// capitals.js is browser-only (it assigns straight to `window.*`); stub `window` before
// requiring so it runs unmodified under Node, then read the data back off the stub.
global.window = {};
require("../public/capitals.js");
const { CAPITALS, US_CAPITALS } = global.window;
delete global.window;

function checkTable(name, table) {
  describe(name, () => {
    test("is a non-empty object", () => {
      assert.ok(table && typeof table === "object");
      assert.ok(Object.keys(table).length > 0);
    });

    test("every entry has a capital name and at least one alias", () => {
      for (const [place, rec] of Object.entries(table)) {
        assert.equal(typeof rec.c, "string", `${place}.c`);
        assert.ok(rec.c.trim().length > 0, `${place}.c non-empty`);
        assert.ok(Array.isArray(rec.a) && rec.a.length > 0, `${place}.a non-empty array`);
        for (const alias of rec.a) assert.equal(typeof alias, "string", `${place}: non-string alias`);
      }
    });

    test("no alias is shared between two different places (geomap's byAlias lookup would only keep one)", () => {
      const ownerOf = new Map();
      for (const [place, rec] of Object.entries(table)) {
        for (const alias of rec.a) {
          const owner = ownerOf.get(alias);
          assert.ok(!owner || owner === place, `alias "${alias}" is claimed by both "${owner}" and "${place}"`);
          ownerOf.set(alias, place);
        }
      }
    });
  });
}

checkTable("window.CAPITALS (world)", CAPITALS);
checkTable("window.US_CAPITALS", US_CAPITALS);

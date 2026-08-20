"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { COUNTRY_CODES, flagCodeFor, flagUrl } = require("../lib/flags.js");

describe("flagCodeFor", () => {
  test("resolves a plain entry by its display name", () => {
    assert.equal(flagCodeFor({ aliases: ["france"] }), "fr");
  });

  test("checks every alias, not just the first", () => {
    assert.equal(flagCodeFor({ aliases: ["dr congo", "democratic republic of the congo", "drc"] }), "cd");
  });

  test("the two Congos resolve to two different codes", () => {
    assert.equal(flagCodeFor({ aliases: ["republic of the congo", "congo-brazzaville"] }), "cg");
    assert.equal(flagCodeFor({ aliases: ["democratic republic of the congo"] }), "cd");
  });

  test("returns null when no alias has a known code", () => {
    assert.equal(flagCodeFor({ aliases: ["narnia"] }), null);
  });

  test("every code in the table is a 2-letter lowercase string", () => {
    for (const [name, code] of Object.entries(COUNTRY_CODES)) {
      assert.match(code, /^[a-z]{2}$/, `${name} → ${code}`);
    }
  });
});

describe("flagUrl", () => {
  test("builds a flagcdn.com SVG URL from the code", () => {
    assert.equal(flagUrl("fr"), "https://flagcdn.com/fr.svg");
  });
});

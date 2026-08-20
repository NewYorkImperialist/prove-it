"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { CAPITALS, US_CAPITALS } = require("../data/capitals.js");
const { CATEGORY_GROUPS } = require("../lib/category-data.js");

const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

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

    // `c` is shown to the player in the round-end "you missed" study list. The original generated
    // dump had lost every non-ASCII character mid-word ("Ciudad de M", "Santo Domingo de Guzm")
    // and carried multi-name artifacts ("Bruxelles [Brussel]", "Rangoon (Yangon)") straight to
    // the screen.
    test("no capital name is a truncated or bracketed dump artifact", () => {
      for (const [place, rec] of Object.entries(table)) {
        assert.ok(!/[[\]()]/.test(rec.c), `${place}: "${rec.c}" still carries a bracketed alternative`);
        assert.ok(!/\s(de|of|del|da)$/i.test(rec.c), `${place}: "${rec.c}" looks cut off mid-name`);
      }
    });

    // Repairing a canonical without adding its normalized form to `a` would silently stop the
    // displayed answer from being accepted — the study list would teach an unusable spelling.
    test("every capital accepts its own displayed name", () => {
      for (const [place, rec] of Object.entries(table)) {
        assert.ok(rec.a.includes(norm(rec.c)), `${place}: displays "${rec.c}" but doesn't accept it`);
      }
    });

    test("aliases are stored pre-normalized (geomap keys its lookup Map on them directly)", () => {
      for (const [place, rec] of Object.entries(table)) {
        for (const alias of rec.a) assert.equal(alias, norm(alias), `${place}: alias "${alias}" is not normalized`);
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

// The solo fill board matches against CAPITALS, while multiplayer matches the "World Capitals"
// category in data/categories.js. Two answer keys for one category name meant a player could be
// taught "Athens" in one mode and marked wrong for it in the other — and both feed the same
// per-category leaderboard.
describe("the fill board agrees with the World Capitals category", () => {
  const cat = CATEGORY_GROUPS.Geography.cats.find((c) => c.name === "World Capitals");
  const accepted = new Set();
  for (const rec of Object.values(CAPITALS)) for (const a of rec.a) accepted.add(norm(a));

  test("the category exists and is non-trivial", () => {
    assert.ok(cat, "World Capitals category not found");
    assert.ok(cat.items.length > 150);
  });

  test("every capital the category teaches is typeable on the fill board", () => {
    const rejected = cat.items
      .map((it) => (Array.isArray(it) ? it[0] : it))
      .filter((name) => !accepted.has(norm(name)));
    assert.deepEqual(rejected, [], `the fill board rejects ${rejected.length} of the category's own answers`);
  });

  test("every alias the category accepts is typeable on the fill board", () => {
    const rejected = [];
    for (const it of cat.items) {
      for (const raw of Array.isArray(it) ? it : [it]) if (!accepted.has(norm(raw))) rejected.push(raw);
    }
    assert.deepEqual(rejected, []);
  });

  // The reverse direction, which is the one that actually bit: the fill board's round-end study
  // list teaches you its OWN canonical, so a name it displays but the category rejects means solo
  // teaches a spelling the duel marks wrong — on a shared category name.
  test("every capital the fill board DISPLAYS is accepted by the category too", () => {
    const catAccepts = new Set();
    for (const it of cat.items) for (const raw of Array.isArray(it) ? it : [it]) catAccepts.add(norm(raw));
    const rejected = Object.entries(CAPITALS)
      .filter(([, rec]) => !catAccepts.has(norm(rec.c)))
      .map(([place, rec]) => `${place} → ${rec.c}`);
    assert.deepEqual(rejected, [], `solo teaches ${rejected.length} capital(s) the duel won't accept`);
  });

  // The file header promises both, and for most of Europe only the English name worked.
  test("well-known endonyms are accepted alongside the English name", () => {
    const pairs = [
      ["Italy", "Roma"], ["Czechia", "Praha"], ["Austria", "Wien"], ["Portugal", "Lisboa"],
      ["Poland", "Warszawa"], ["Serbia", "Beograd"], ["Romania", "Bucuresti"],
      ["Greece", "Athina"], ["Vietnam", "Ha Noi"], ["Denmark", "Kobenhavn"],
    ];
    const missing = pairs.filter(([place, endonym]) => !CAPITALS[place].a.includes(norm(endonym)));
    assert.deepEqual(missing, []);
  });

  // The canonical checks above aren't enough on their own: the aliases have to match too. The
  // fill board accepted "Wien", "Praha" and "La Habana" while the duel's category — a separate,
  // hand-written alias list under the same category name and the same leaderboard — did not.
  // data/categories.js's World Capitals items are generated from data/capitals.js now
  // (tools/gen-capitals.js); this is what catches it if the two ever drift apart again.
  test("both modes accept exactly the same set of spellings", () => {
    const catAccepts = new Set();
    for (const it of cat.items) for (const raw of Array.isArray(it) ? it : [it]) catAccepts.add(norm(raw));
    const fillAccepts = new Set();
    for (const rec of Object.values(CAPITALS)) for (const a of rec.a) fillAccepts.add(a);
    const duelRejects = [...fillAccepts].filter((a) => !catAccepts.has(a));
    const fillRejects = [...catAccepts].filter((a) => !fillAccepts.has(a));
    assert.deepEqual(duelRejects, [], "the fill board accepts spellings the duel marks wrong");
    assert.deepEqual(fillRejects, [], "the duel accepts spellings the fill board marks wrong");
  });

  // …and the English name is what gets DISPLAYED, since that's what the study list teaches.
  test("a capital with a common English name displays it, not the endonym", () => {
    const expected = {
      Greece: "Athens", Cuba: "Havana", Oman: "Muscat", Uzbekistan: "Tashkent",
      Sudan: "Khartoum", Mexico: "Mexico City", Bahrain: "Manama", Panama: "Panama City",
    };
    for (const [place, want] of Object.entries(expected)) {
      assert.equal(CAPITALS[place].c, want, `${place} still displays "${CAPITALS[place].c}"`);
    }
  });
});

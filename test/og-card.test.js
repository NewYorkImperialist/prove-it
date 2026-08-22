"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const SITE = require("../lib/site-config.js");
const { KINDS, bragLine, cardParams, parseCard, cardKey, cardCopy, cardUrl, cardAlt } = require("../lib/og-card.js");
const { allBoards } = require("../lib/geo-boards.js");

// parseCard is the only thing standing between a crafted share link and 200px-tall text in a PNG
// that Discord will then cache and show to a whole group chat. Everything a stranger can put in the
// query string is exercised below; the rule the image route depends on is that this function is
// TOTAL — it always returns a renderable card, and never throws, whatever it is handed.
describe("lib/og-card.js · parseCard is a validating boundary", () => {
  test("a well-formed challenge survives intact", () => {
    const card = parseCard({ k: "challenge", n: "Jayden", s: "12", c: "Countries of the World", r: "3", t: "45" });
    assert.deepEqual(card, { kind: "challenge", by: "Jayden", score: 12, category: "Countries of the World",
      sub: "", rounds: 3, timer: 45, code: "" });
  });

  test("an unknown kind collapses to the generic card rather than rendering its params", () => {
    const card = parseCard({ k: "../../etc/passwd", n: "Jayden", s: "12", c: "US States" });
    assert.equal(card.kind, "generic");
    assert.equal(card.by, "", "the name must not survive into a card we never designed");
    assert.equal(card.score, null);
    assert.equal(card.category, "");
  });

  test("every allowlisted kind is accepted and nothing else is", () => {
    for (const k of KINDS) assert.equal(parseCard({ k, n: "Jayden", s: "5", c: "US States", x: "AB12" }).kind, k);
    for (const k of ["Challenge", "geo ", "", "0", "__proto__", "constructor"]) {
      assert.equal(parseCard({ k }).kind, "generic", `kind ${JSON.stringify(k)} should not be honoured`);
    }
  });

  test("an oversized name is clamped, and never truncated mid-character", () => {
    const card = parseCard({ k: "challenge", n: "A".repeat(400), s: "5", c: "US States" });
    assert.equal(Array.from(card.by).length, 20);
    // Clamping happens by code point: cutting "\u{1F600}" in half leaves a lone surrogate, which is
    // not text any font shaper can be handed.
    const emoji = parseCard({ k: "challenge", n: "\u{1F600}".repeat(40), s: "5", c: "US States" });
    assert.equal(Array.from(emoji.by).length, 20);
    assert.ok(emoji.by.isWellFormed(), "clamping must not leave an unpaired surrogate behind");
  });

  test("control characters, newlines and bidi overrides are stripped out of a name", () => {
    const hostile = "Jay\tden\r\n<script>‮evil​​​";
    const card = parseCard({ k: "challenge", n: hostile, s: "5", c: "US States" });
    for (const ch of card.by) {
      const cp = ch.codePointAt(0);
      assert.ok(cp >= 0x20, `control character U+${cp.toString(16)} survived`);
      assert.ok(!(cp >= 0x202a && cp <= 0x202e), "a bidi override survived and could reverse the sentence around it");
      assert.ok(!(cp >= 0x200b && cp <= 0x200f), "a zero-width character survived and pads a name past the clamp");
    }
    assert.ok(!/[\r\n]/.test(card.by), "a newline would break both the query string and satori's SVG");
    assert.ok(!/ {2}/.test(card.by), "whitespace is collapsed, so a name can't be padded out with runs of spaces");
  });

  test("a blocked name becomes Anon, exactly as it would on the leaderboard", () => {
    assert.equal(parseCard({ k: "challenge", n: "n1gg4", s: "5", c: "US States" }).by, "Anon");
  });

  test("a score that isn't a finite number is dropped rather than drawn", () => {
    for (const s of ["", "   ", "abc", "12abc", "NaN", "Infinity", "-Infinity", "1e999", "null", "[]"]) {
      assert.equal(parseCard({ k: "challenge", n: "Jayden", s, c: "US States" }).score, null,
        `score ${JSON.stringify(s)} should be dropped`);
    }
  });

  test("negative and absurd scores are clamped into a range a card can draw", () => {
    assert.equal(parseCard({ k: "challenge", n: "Jayden", s: "-5", c: "US States" }).score, 0);
    assert.equal(parseCard({ k: "challenge", n: "Jayden", s: "-99999999", c: "US States" }).score, 0);
    assert.equal(parseCard({ k: "challenge", n: "Jayden", s: "99999999999", c: "US States" }).score, 9999);
    assert.equal(parseCard({ k: "challenge", n: "Jayden", s: "12.9", c: "US States" }).score, 12);
  });

  test("a category longer than the clamp is cut to something that fits the canvas", () => {
    const card = parseCard({ k: "challenge", n: "Jayden", s: "5", c: "Z".repeat(500) });
    assert.equal(Array.from(card.category).length, 48);
    assert.ok(cardCopy(card).category.length <= 48, "the drawn subject line has to stay inside the 1072px of usable width");
  });

  test("a known category is canonicalised, an unknown one is kept rather than rejected", () => {
    // A category renamed since a link was shared should still render — a generic card for every
    // link shared before the rename would be the worse failure.
    assert.equal(parseCard({ k: "challenge", n: "Jayden", s: "5", c: "us states" }).category, "US States");
    assert.equal(parseCard({ k: "challenge", n: "Jayden", s: "5", c: "Retired Category" }).category, "Retired Category");
  });

  test("a room code is normalised to [A-Z0-9]{1,4}, and one with nothing left in it is generic", () => {
    assert.equal(parseCard({ k: "room", x: "ab1" }).code, "AB1");
    assert.equal(parseCard({ k: "room", x: "a-b!c9zzzz" }).code, "ABC9");
    // Anything that isn't a letter or a digit is dropped rather than rejected, so junk degrades to
    // a harmless code and never to markup on the canvas.
    assert.equal(parseCard({ k: "room", x: "<script>" }).code, "SCRI");
    for (const x of ["", "!!!", "----", " ", "<>"]) {
      assert.equal(parseCard({ k: "room", x }).kind, "generic", `room code ${JSON.stringify(x)} should not make a room card`);
    }
  });

  test("a challenge with nobody challenging you is generic, not a card with a hole in it", () => {
    assert.equal(parseCard({ k: "challenge" }).kind, "generic");
    assert.equal(parseCard({ k: "daily", c: "US States" }).kind, "generic");
    assert.equal(parseCard({ k: "challenge", n: "Jayden" }).kind, "challenge", "a name alone is enough to say who");
  });

  test("a geo card takes its number and label from our own board table, not from the URL", () => {
    const board = allBoards().find((b) => b.name === "Countries of the World");
    const forged = parseCard({ k: "geo", c: "countries of the world", s: "9999", b: "totally legit" });
    assert.equal(forged.category, board.name, "and the board name is canonicalised on the way through");
    assert.equal(forged.score, board.answers);
    assert.equal(forged.sub, "Name the map · World");
  });

  test("an unknown board still renders the geography card, just the generic one", () => {
    // ?geo=1 is the app's own "open the Geography screen" deep link, so this is a normal request.
    for (const c of ["1", "Atlantis", ""]) {
      const card = parseCard({ k: "geo", c });
      assert.equal(card.kind, "geo");
      assert.equal(card.category, "");
      assert.equal(card.score, null);
      assert.match(cardCopy(card).headline, /Maps, flags/);
    }
  });

  test("rounds and timer are clamped, and a timer of 0 is a real value rather than an absent one", () => {
    assert.equal(parseCard({ k: "challenge", n: "J", r: "99" }).rounds, 10);
    assert.equal(parseCard({ k: "challenge", n: "J", r: "0" }).rounds, 1);
    assert.equal(parseCard({ k: "challenge", n: "J", r: "" }).rounds, null);
    assert.equal(parseCard({ k: "challenge", n: "J", t: "0" }).timer, 0, "0 means 'recommended time per round'");
    assert.equal(parseCard({ k: "challenge", n: "J", t: "999999" }).timer, 1800);
  });

  test("a repeated param takes its first value, however it arrived", () => {
    // Express hands over an array for ?n=a&n=b; URLSearchParams hands over the first.
    assert.equal(parseCard({ k: "challenge", n: ["Jayden", "Someone Else"], s: "5", c: "US States" }).by, "Jayden");
    assert.equal(parseCard(new URLSearchParams("k=challenge&n=Jayden&n=Someone+Else&s=5&c=US+States")).by, "Jayden");
  });

  test("it never throws, whatever it is handed", () => {
    const nasty = [undefined, null, "", 0, [], "not an object", { k: {} }, { k: "challenge", n: {}, s: {}, c: [] },
      { k: "challenge", get n() { throw new Error("boom"); } }, new URLSearchParams()];
    for (const [i, q] of nasty.entries()) {
      // Not JSON.stringify'd in the messages below: one of these inputs throws when it is READ, and
      // that is the whole point of it.
      const card = parseCard(q);
      assert.ok(KINDS.includes(card.kind), `nasty input #${i} produced an unrenderable kind`);
      const copy = cardCopy(card);
      for (const field of ["eyebrow", "headline", "big", "category", "footer", "alt"]) {
        assert.equal(typeof copy[field], "string", `${field} must always be a string the renderer can draw`);
      }
    }
  });
});

describe("lib/og-card.js · cardParams and cardUrl", () => {
  test("cardUrl is absolute, because a crawler has no base to resolve a path against", () => {
    const url = cardUrl("challenge", { by: "Jayden", score: 12, category: "Countries of the World" });
    assert.ok(url.startsWith("https://"), url);
    assert.equal(new URL(url).origin, new URL(SITE.url).origin);
    assert.equal(new URL(url).pathname, SITE.ogCard.path);
    assert.equal(new URL(url).searchParams.get("v"), String(SITE.ogCard.v), "the ?v= is what busts a redesign");
  });

  test("the params it writes are the params parseCard reads back", () => {
    const card = parseCard(cardParams("challenge", { by: "Jayden", score: 12, category: "US States", rounds: ["a", "b"], timer: 0, sub: "Geography" }));
    assert.equal(card.by, "Jayden");
    assert.equal(card.score, 12);
    assert.equal(card.category, "US States");
    assert.equal(card.rounds, 2, "a rounds ARRAY is what a challenge row holds, so it counts itself");
    assert.equal(card.timer, 0);
    assert.equal(card.sub, "Geography");
  });

  test("what it builds is already validated, so our own links can't be the ones rendering generic", () => {
    const params = cardParams("challenge", { by: "A".repeat(99), score: -3, category: "us states" });
    assert.equal(Array.from(params.n).length, 20);
    assert.equal(params.s, "0");
    assert.equal(params.c, "US States");
    assert.equal(params.k, "challenge");
  });

  test("a geo card's URL carries only the board name", () => {
    assert.deepEqual(cardParams("geo", { board: "Flags of Europe" }), { k: "geo", c: "Flags of Europe" });
    assert.equal(cardParams("room", { code: "ab1" }).x, "AB1");
  });

  test("an unrecognised kind builds a generic URL rather than a broken one", () => {
    const url = new URL(cardUrl("nope", { by: "Jayden", score: 12, category: "US States" }));
    assert.equal(url.searchParams.get("k"), "generic");
    assert.equal(url.searchParams.get("n"), null);
  });

  test("cardKey folds equivalent URLs onto one cache entry", () => {
    const a = cardKey(parseCard(new URLSearchParams("k=geo&c=countries+of+the+world")));
    const b = cardKey(parseCard(new URLSearchParams("k=geo&c=Countries%20of%20the%20World&s=1&b=x")));
    assert.equal(a, b, "otherwise the same picture is re-rendered once per casing a sharer happened to use");
    assert.notEqual(a, cardKey(parseCard(new URLSearchParams("k=geo&c=Flags+of+Europe"))));
  });

  test("cardAlt describes the picture for a screen reader, per shape", () => {
    assert.match(cardAlt("challenge", { by: "Jayden", score: 12, category: "US States" }), /12 US States/);
    assert.match(cardAlt("room", { code: "AB12" }), /room AB12/);
    assert.match(cardAlt("geo", { board: "US States" }), /US States/);
    assert.equal(cardAlt("generic", {}), SITE.ogImage.alt);
  });
});

// The card and the crawler-facing <title> say the same sentence, so the wording lives in one
// function. challengePreview() in routes/challenge.js renders this with a leading bolt.
describe("lib/og-card.js · bragLine", () => {
  test("a score above 1 reads as a count of the category", () => {
    assert.equal(bragLine({ by: "Jayden", score: 17, category: "US States" }),
      "Jayden says you can't name more than 17 US States");
  });

  test("a score of 1 doesn't get glued to a plural category name", () => {
    assert.equal(bragLine({ by: "Jayden", score: 1, category: "US States" }),
      "Jayden says you can't name more than 1 answer in US States");
  });

  test("with no score to quote it falls back to the plain challenge line", () => {
    assert.equal(bragLine({ by: "Jayden", score: null, category: "US States" }), "Jayden challenged you on Prove It!");
    assert.equal(bragLine({ by: "Jayden", score: 12, category: "" }), "Jayden challenged you on Prove It!");
    assert.equal(bragLine({ by: "Jayden", score: 0, category: "US States" }), "Jayden challenged you on Prove It!");
    assert.equal(bragLine({}), "A friend challenged you on Prove It!");
  });
});

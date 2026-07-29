"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { esc, easternHour, easternTime, easternFull, easternDay, fmtHour12, fmtDur, fmtMs, bar, tbl } = require("../lib/html.js");

describe("esc", () => {
  test("escapes &, <, >, and \" but leaves other characters alone", () => {
    assert.equal(esc(`<b>Tom & "Jerry"</b>`), "&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;");
  });
  test("coerces non-strings", () => {
    assert.equal(esc(42), "42");
    assert.equal(esc(null), "null");
  });
});

describe("fmtDur", () => {
  test("null/undefined duration renders as '?'", () => {
    assert.equal(fmtDur(null), "?");
    assert.equal(fmtDur(undefined), "?");
  });
  test("under a minute renders as seconds", () => {
    assert.equal(fmtDur(5000), "5s");
    assert.equal(fmtDur(0), "0s");
  });
  test("under an hour renders as minutes + seconds", () => {
    assert.equal(fmtDur(65000), "1m 5s");
  });
  test("an hour or more renders as hours + minutes", () => {
    assert.equal(fmtDur(3661000), "1h 1m");
  });
});

describe("fmtMs", () => {
  test("falsy (0/null) renders as an em dash", () => {
    assert.equal(fmtMs(0), "—");
    assert.equal(fmtMs(null), "—");
  });
  test("delegates to fmtDur otherwise", () => {
    assert.equal(fmtMs(5000), "5s");
  });
});

describe("bar", () => {
  test("scales width to the max and gives a nonzero bar a minimum width", () => {
    assert.match(bar(5, 10), /width:50%/);
    assert.match(bar(5, 10), /min-width:3px/);
  });
  test("zero value gets 0 width and 0 min-width", () => {
    assert.match(bar(0, 10), /width:0%/);
    assert.match(bar(0, 10), /min-width:0px/);
  });
  test("zero max doesn't divide by zero", () => {
    assert.match(bar(5, 0), /width:0%/);
  });
});

describe("tbl", () => {
  test("renders a header row from the head array", () => {
    const html = tbl(["A", "B"], "<tr><td>1</td></tr>", 2);
    assert.match(html, /<th>A<\/th><th>B<\/th>/);
    assert.match(html, /<tr><td>1<\/td><\/tr>/);
  });
  test("falls back to a placeholder row spanning every column when rows is empty", () => {
    const html = tbl(["A", "B"], "", 2);
    assert.match(html, /<td colspan=2>—<\/td>/);
  });
});

describe("fmtHour12", () => {
  test("midnight and noon are special-cased to 12, not 0", () => {
    assert.equal(fmtHour12(0), "12 AM");
    assert.equal(fmtHour12(12), "12 PM");
  });
  test("afternoon hours convert to 12-hour PM", () => {
    assert.equal(fmtHour12(13), "1 PM");
    assert.equal(fmtHour12(23), "11 PM");
  });
});

describe("Eastern time formatting", () => {
  // Noon UTC on Jan 1 2024 is 7am in New York (EST, no DST in January).
  const jan1NoonUtc = Date.UTC(2024, 0, 1, 12, 0, 0);

  test("easternHour converts a UTC timestamp to the Eastern hour-of-day", () => {
    assert.equal(easternHour(jan1NoonUtc), 7);
  });
  test("easternDay returns an ISO-style YYYY-MM-DD in Eastern time", () => {
    assert.equal(easternDay(jan1NoonUtc), "2024-01-01");
  });
  test("easternTime and easternFull return non-empty human-readable strings", () => {
    assert.ok(easternTime(jan1NoonUtc).length > 0);
    assert.match(easternFull(jan1NoonUtc), / ET$/);
  });
});

"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { cleanName, isBlocked } = require("../lib/name-filter.js");

describe("cleanName", () => {
  test("leaves ordinary names untouched", () => {
    assert.equal(cleanName("Jayden"), "Jayden");
    assert.equal(cleanName("mark"), "mark");
    assert.equal(cleanName("sigma"), "sigma");
  });

  test("blocks a straightforward slur", () => {
    assert.equal(cleanName("Nigga"), "Anon");
  });

  test("blocks leetspeak evasion", () => {
    assert.equal(cleanName("n1gg4"), "Anon");
  });

  test("blocks spaced/punctuated evasion", () => {
    assert.equal(cleanName("n i g g a"), "Anon");
    assert.equal(cleanName("n.i.g.g.e.r"), "Anon");
  });

  test("blocks ordinary profanity too", () => {
    assert.equal(cleanName("fuck you"), "Anon");
  });

  test("does not false-positive on words that merely contain a blocked substring", () => {
    assert.equal(cleanName("Scunthorpe"), "Scunthorpe");
    assert.equal(cleanName("class"), "class");
    assert.equal(cleanName("Cockburn"), "Cockburn");
  });

  test("blank input falls back to Anon", () => {
    assert.equal(cleanName(""), "Anon");
    assert.equal(cleanName(null), "Anon");
    assert.equal(cleanName(undefined), "Anon");
  });

  test("trims whitespace", () => {
    assert.equal(cleanName("  Jayden  "), "Jayden");
  });
});

describe("isBlocked", () => {
  test("flags profanity/slurs and their evasions", () => {
    assert.equal(isBlocked("Nigga"), true);
    assert.equal(isBlocked("n1gg4"), true);
    assert.equal(isBlocked("fuck you"), true);
  });
  test("passes clean names and whitelisted lookalikes", () => {
    assert.equal(isBlocked("Jayden"), false);
    assert.equal(isBlocked("Scunthorpe"), false);
  });
  test("blank input is not considered blocked", () => {
    assert.equal(isBlocked(""), false);
    assert.equal(isBlocked(null), false);
  });
});

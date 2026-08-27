"use strict";
// Read a source file as CODE, with comments removed.
//
// This exists because the same mistake happened four times in one afternoon. A test asserts "X must
// not appear in this file", the code is changed to remove X, and a comment is added explaining why X
// is gone — which contains the word X. The assertion matches the comment, so the test now fails when
// the code is RIGHT and would pass if someone put X back without explaining it. Exactly backwards.
//
// The three that actually bit:
//   • "no <text> element in the favicon" matched "A <text> element renders with whatever font…"
//   • "no encodeURIComponent(key) in the probe" matched the comment on why the key moved to a header
//   • "no ownerKeyOk in the public rename route" matched the comment on why that branch was deleted
//
// So: strip comments before asserting on structure, and assert on the RAW text only when what you
// want to check is the prose itself.
//
// Deliberately simple — a regex, not a parser. It handles the two comment forms this codebase uses
// and the one trap that matters (a "//" inside a string literal, which appears in every URL). It is
// not trying to be correct for arbitrary JavaScript; if a test ever needs that, the test is asking
// the wrong question and should assert on behaviour instead.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

// Remove /* … */ and // … , leaving string literals alone.
function codeOnly(src) {
  let out = "";
  let i = 0;
  let quote = null; // the delimiter we're inside, or null
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") { out += next ?? ""; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i += 1; continue; }
    if (c === "/" && next === "/") { while (i < src.length && src[i] !== "\n") i += 1; continue; }
    if (c === "/" && next === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1; i += 2; continue; }
    out += c;
    i += 1;
  }
  return out;
}

// The file's code, comments stripped. Use for "this must / must not appear" structural checks.
const readCode = (rel) => codeOnly(fs.readFileSync(path.join(ROOT, rel), "utf8"));

// The file verbatim. Use only when the prose is the thing being checked.
const readRaw = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

module.exports = { codeOnly, readCode, readRaw, ROOT };

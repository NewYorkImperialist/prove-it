"use strict";
const fs = require("fs");
const { CAPITALS } = require("/home/user/prove-it/data/capitals.js");

// [display, ...accepted spellings] per country, in country order (same order the file already had).
const items = Object.values(CAPITALS).map((rec) => {
  const seen = new Set();
  const all = [rec.c, ...rec.a].filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return all.length === 1 ? JSON.stringify(all[0]) : "[" + all.map((x) => JSON.stringify(x)).join(",") + "]";
});

// wrap at ~118 cols with 6-space indent, matching the file's style
const lines = [];
let cur = "";
for (const it of items) {
  const next = cur ? cur + ", " + it : it;
  if (next.length > 112) { lines.push("      " + cur + ","); cur = it; } else cur = next;
}
if (cur) lines.push("      " + cur + ",");

const block = `    { name: "World Capitals", items: [
      // GENERATED from data/capitals.js — the solo fill board matches against that file while
      // multiplayer matches this one, on a shared category name and a shared leaderboard. Keeping
      // two hand-written alias lists in step failed exactly the way you'd expect: the fill board
      // accepted "Wien" and "Praha" and the duel didn't. Regenerate with tools/gen-capitals.js;
      // test/capitals.test.js fails if the two ever disagree in either direction.
${lines.join("\n")}
    ]},`;

const p = "/home/user/prove-it/data/categories.js";
const s = fs.readFileSync(p, "utf8");
const start = s.indexOf('    { name: "World Capitals", items: [');
if (start < 0) throw new Error("World Capitals block not found");
const end = s.indexOf("]},", start) + "]},".length;
fs.writeFileSync(p, s.slice(0, start) + block + s.slice(end));
console.log("replaced", end - start, "chars with", block.length, "-", items.length, "items");

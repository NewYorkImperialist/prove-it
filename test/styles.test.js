"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

// Tailwind silently DROPS a utility whose variant it doesn't know — no build error, no warning,
// the class just does nothing. So a typo'd or deleted variant is invisible until someone opens the
// app on the device the variant existed for. These checks are what the node:test harness can
// actually assert about styling (there's no DOM here); layout itself is verified in a browser.
const ROOT = path.join(__dirname, "..");
const CSS = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(rel, out);
    else if (/\.(jsx?|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const FILES = [...sourceFiles("components"), ...sourceFiles("app"), ...sourceFiles("hooks")];

describe("Tailwind variants used in markup are actually defined", () => {
  // Anything of the form `foo:` that isn't a stock Tailwind variant has to be declared with
  // @custom-variant or come from a @theme breakpoint, or it compiles to nothing.
  const DECLARED = new Set([
    ...[...CSS.matchAll(/@custom-variant\s+([a-z0-9-]+)\s/g)].map((m) => m[1]),
    ...[...CSS.matchAll(/--breakpoint-([a-z0-9-]+)\s*:/g)].map((m) => m[1]),
  ]);

  test("globals.css declares the project's own variants", () => {
    assert.ok(DECLARED.has("desk"), "the desk breakpoint should come from @theme");
    // `short:` is what keeps a landscape phone (wide enough for desk:, ~390px tall) from getting
    // the full desktop layout — without it the geography board collapses to zero height.
    assert.ok(DECLARED.has("short"), "the short viewport variant should be declared");
  });

  test("no component uses a project variant that globals.css doesn't define", () => {
    // Only the variants this project invents. Stock Tailwind ones (hover:, focus:, …) and
    // arbitrary queries (min-[360px]:) are Tailwind's own business.
    const bad = [];
    for (const f of FILES) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const m of src.matchAll(/\b(desk|short)\s*:\s*[a-z[]/g)) {
        if (!DECLARED.has(m[1])) bad.push(`${f}: ${m[1]}:`);
      }
    }
    assert.deepEqual([...new Set(bad)], [], "these variants are used but never declared, so they compile away");
  });

  test("the short variant is height-based, so a landscape phone matches it", () => {
    const m = CSS.match(/@custom-variant\s+short\s*\(([^)]*)\)/);
    assert.ok(m, "short variant not found");
    assert.match(m[1], /max-height/, "short: has to key off height — width is what desk: already does");
    const px = Number((m[1].match(/max-height:\s*(\d+)px/) || [])[1]);
    assert.ok(px >= 380 && px <= 700, `max-height ${px}px should cover a landscape phone (~390) but not a tablet`);
  });
});

// The geography board's projection is fitted to the container's measured box exactly once, at
// setup. Rotating a phone changes that box completely, and the drawn SVG can't know — it
// letterboxes inside its stale viewBox, and the dot-vs-box decision (which depends on the height
// available) was made for the old shape. There's no DOM in this harness, so this is a source
// check: it pins that the re-measure path exists and is wired up, which is what silently went
// missing before.
describe("the geography board re-measures when its box changes", () => {
  const GEOMAP = fs.readFileSync(path.join(ROOT, "lib/browser/geomap.js"), "utf8");

  test("geomap watches its container for size changes", () => {
    assert.match(GEOMAP, /new ResizeObserver\(/, "nothing observes the container, so a rotation is invisible");
    assert.match(GEOMAP, /sizeObserver\.observe\(container\)/);
  });

  test("the observer is disconnected on teardown and before a fresh setup", () => {
    // Left connected, it would keep re-projecting into a detached node from a previous round.
    const teardown = GEOMAP.slice(GEOMAP.indexOf("teardown()"));
    assert.match(teardown, /stopWatchingSize\(\)/, "teardown leaves the observer running");
    const setup = GEOMAP.slice(GEOMAP.indexOf("async setup("), GEOMAP.indexOf("light(entryId)"));
    assert.match(setup, /stopWatchingSize\(\)/, "a new round leaves the previous observer running");
  });

  test("a redraw restores what was already named, not just the outlines", () => {
    // Without this a rotation mid-round would blank every country you'd already got.
    const redraw = GEOMAP.slice(GEOMAP.indexOf("async redraw()"), GEOMAP.indexOf("// Borders quiz: highlight"));
    assert.match(redraw, /for \(const id of litIds\)/, "a redraw has to re-light the named entries");
    assert.match(redraw, /quizTargetId/, "…and restore the borders-quiz target");
  });

  test("fill mode is deliberately never redrawn", () => {
    // It's a CSS grid that reflows on its own, and rebuilding it would wipe the typed answers.
    const setup = GEOMAP.slice(GEOMAP.indexOf("async setup("), GEOMAP.indexOf("light(entryId)"));
    const fillReturn = setup.indexOf('return setupFill(');
    const watch = setup.indexOf("watchSize(container)");
    assert.ok(fillReturn !== -1 && watch !== -1 && fillReturn < watch, "fill mode must return before the observer is attached");
  });
});

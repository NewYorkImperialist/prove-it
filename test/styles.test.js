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

// The brand mark exists two ways round on purpose, which is exactly the kind of thing a later
// tidy-up "fixes" into consistency. Both halves are asserted here so that lands as a failing test
// with a reason rather than as a silent visual change:
//
//   favicon + in-app badge  → dark ◎ on a FILLED AMBER plate. They compete with other favicons in
//     a tab strip and sit on this app's own near-black panels; the filled plate is what makes the
//     mark findable there, and 1acaf45's amber-on-black version needed a border to stop the plate
//     vanishing into the background behind it.
//   PWA / home-screen icons → amber ◎ on a NEAR-BLACK plate. Those sit on the user's wallpaper
//     among their other apps, where a solid amber square is a bright blob.
describe("the brand mark is filled amber in the browser and dark-plated once installed", () => {
  const FAV = fs.readFileSync(path.join(ROOT, "lib/favicon.js"), "utf8");
  const LOGO = fs.readFileSync(path.join(ROOT, "components/ui/Logo.jsx"), "utf8");
  const ICONS = fs.readFileSync(path.join(ROOT, "scripts/make-icons.js"), "utf8");
  // The rendered data URI, not the source text: the source has the words "<text" in a comment
  // explaining why there isn't one, which a source-level check happily matched.
  const { FAVICON } = require("../lib/favicon.js");

  test("the favicon plate is amber and its mark is dark", () => {
    assert.match(FAVICON, /<rect[^>]*fill='%23f5a623'/, "plate should be --accent");
    assert.match(FAVICON, /fill='%23241500'/, "the dot should be --markfg");
    assert.match(FAVICON, /stroke='%23241500'/, "and so should the ring");
  });

  test("the favicon draws the mark as circles, not as the ◎ character", () => {
    // U+25CE lives in Noto Sans Symbols, which this app bundles nowhere, so a <text> mark rendered
    // with whatever font the device had — or as a tofu box. scripts/make-icons.js has always drawn
    // geometry for exactly this reason; the favicon relying on the glyph meant the two could
    // disagree about what the logo looks like on a machine nobody tested on.
    assert.equal(/<text/.test(FAVICON), false, "no text element — the glyph is not guaranteed to exist");
    assert.equal(/◎/.test(FAVICON), false);
    assert.match(FAVICON, /<circle[^>]*stroke='%23241500'[^>]*stroke-width='7\.5'/, "the ring, as a stroked circle");
    assert.match(FAVICON, /<circle[^>]*r='11\.5'[^>]*fill='%23241500'/, "and the dot");
  });

  test("the favicon's geometry is the same numbers as the generated icons", () => {
    // One mark at one set of proportions, rather than three things that happen to look alike.
    // ring outer 31 / inner 23.5 becomes a stroke on the midline 27.25 of width 7.5.
    assert.match(ICONS, /ring: \{ cx: 50, cy: 50, outer: 31, inner: 23\.5 \}/);
    assert.match(ICONS, /dot: \{ cx: 50, cy: 50, r: 11\.5 \}/);
    assert.match(FAVICON, /r='27\.25'/, "ring midline = (31 + 23.5) / 2");
    assert.match(FAVICON, /stroke-width='7\.5'/, "ring width = 31 - 23.5");
    assert.match(FAVICON, /x='8' y='8' width='84' height='84' rx='20'/, "and the same plate");
  });

  test("the in-app badge is the amber plate with the dark glyph, and needs no border", () => {
    const badge = LOGO.slice(LOGO.indexOf("export function LogoBadge"), LOGO.indexOf("// select-none for the same reason"));
    assert.match(badge, /bg-\[linear-gradient\(140deg,#f5a623,#e0801a\)\]/);
    assert.match(badge, /text-markfg/);
    assert.match(badge, /\[-webkit-text-stroke:\.9px_#241500\]/, "the stroke that gives the glyph its weight");
    assert.match(badge, /◎/);
    assert.equal(/\bborder\b/.test(badge), false, "a filled plate is its own edge");
  });

  test("the logo is not selectable, which is a cosmetic choice and nothing more", () => {
    // Dragging a selection across the page painted a highlight box over the logo, which reads as a
    // mistake. That is the whole reason — the mark is still a text glyph, still in the document, and
    // user-select:none only excludes it from a selection.
    const badge = LOGO.slice(LOGO.indexOf("export function LogoBadge"), LOGO.indexOf("// select-none for the same reason"));
    assert.match(badge, /select-none/);
    // Deliberately NOT here: the drag and pointer-events defences a previous pass added. They were
    // answering a threat model this isn't, and pointer-events-none on the mark meant a click had to
    // pass through it to reach the top bar's logo button.
    assert.equal(/-webkit-user-drag/.test(badge), false);
    assert.equal(/pointer-events-none/.test(badge), false);
    // The wordmark too: selecting the header on the way somewhere else used to sweep the brand name in.
    const word = LOGO.slice(LOGO.indexOf("export function Wordmark"));
    assert.match(word.slice(0, 400), /select-none/);
  });

  test("the generated icons are the inverse: amber mark, near-black plate", () => {
    // sample() paints the ring/dot amber and everything else inside the plate near-black (with the
    // admin build's blue stripe in between) — so the mark is the bright half, unlike the favicon.
    const s = ICONS.slice(ICONS.indexOf("function sample("), ICONS.indexOf("const SS ="));
    assert.match(s, /if \(onMark\) return AMBER;/);
    assert.match(s, /return PANEL;/);
    assert.equal(/return onMark \? PANEL : AMBER/.test(s), false, "that would be the favicon's way round");
    assert.match(ICONS, /const AMBER = \[0xf5, 0xa6, 0x23\]/);
    assert.match(ICONS, /const PANEL = \[0x14, 0x11, 0x0c\]/);
  });

  test("and each file says the divergence is deliberate, so it reads as a decision", () => {
    for (const [name, src] of [["lib/favicon.js", FAV], ["components/ui/Logo.jsx", LOGO], ["scripts/make-icons.js", ICONS]]) {
      assert.match(src, /home-screen icons|installed icon|INVERSE|favicon/i, name);
    }
  });
});

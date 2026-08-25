"use strict";
// The brand mark, checked by RENDERING it rather than by reading the source.
//
// This spec exists because the source was right three times while the thing on screen was reported
// wrong, and a source-level assertion cannot tell the difference. Two failures it would have caught
// that no node:test could:
//
//  • The mark used to be the "◎" character (U+25CE). That glyph lives in Noto Sans Symbols, which
//    this app bundles nowhere, so what a device actually painted depended on its fonts — rings, a
//    tofu box, or nothing. It is drawn as circles now, and the only way to know is to rasterise it.
//  • The logo was selectable text, so dragging across the header put the logo on the clipboard as a
//    character. "Is it selectable" is a question only a browser can answer.
const { test, expect } = require("@playwright/test");
const { FAVICON } = require("../lib/favicon.js");

// Rasterise the favicon into a canvas and read pixels back out of it.
async function raster(page, size) {
  return page.evaluate(async ([href, N]) => {
    const img = new Image();
    img.src = href;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = N; cv.height = N;
    const cx = cv.getContext("2d");
    cx.drawImage(img, 0, 0, N, N);
    const at = (x, y) => {
      const d = cx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      return { rgb: [d[0], d[1], d[2]], a: d[3] };
    };
    // The centre row, as "is this pixel dark and opaque", so the ring/dot/ring banding is countable.
    const row = [];
    for (let x = 0; x < N; x++) {
      const p = at(x, N / 2);
      row.push(p.a > 200 && (p.rgb[0] + p.rgb[1] + p.rgb[2]) / 3 < 110 ? 1 : 0);
    }
    let bands = 0;
    for (let i = 0; i < row.length; i++) if (row[i] && !row[i - 1]) bands++;
    // `gap` has to land in the clear band between the dot (r 11.5) and the ring's inner edge
    // (r 23.5) on the 0-100 viewBox — so ~0.175 of the width out from centre. 0.09 was still
    // inside the dot, which read as "the gap is dark" and looked like a filled blob.
    return { plate: at(N / 2, N * 0.12), centre: at(N / 2, N / 2), gap: at(N / 2 + N * 0.175, N / 2), bands };
  }, [FAVICON, size]);
}

test.describe("the favicon", () => {
  test("has an orange plate and a black mark", async ({ page }) => {
    await page.goto("/");
    const r = await raster(page, 96);
    expect(r.plate.rgb, "the plate is --accent").toEqual([245, 166, 35]);
    expect(r.centre.rgb, "the dot at the centre is --markfg").toEqual([36, 21, 0]);
  });

  test("paints rings, not a glyph or a blob", async ({ page }) => {
    await page.goto("/");
    const r = await raster(page, 96);
    // Across the centre: ring, orange gap, dot, orange gap, ring. Three dark bands inside the plate.
    expect(r.bands, `expected ring/dot/ring banding, got ${r.bands} dark bands`).toBeGreaterThanOrEqual(3);
    // And the gap between dot and ring really is plate-coloured — a filled blob would fail this.
    expect(r.gap.rgb, "the space between the dot and the ring must be orange").toEqual([245, 166, 35]);
  });

  test("renders the same at 16px, which is the size that actually ships", async ({ page }) => {
    // A tab favicon is 16px. Geometry survives that; a missing glyph does not.
    await page.goto("/");
    const r = await raster(page, 16);
    expect(r.plate.rgb).toEqual([245, 166, 35]);
    expect((r.centre.rgb[0] + r.centre.rgb[1] + r.centre.rgb[2]) / 3, "the mark is still visible at 16px").toBeLessThan(140);
  });

  test("is what the page actually declares", async ({ page }) => {
    // Asserting on the imported constant proves nothing about the served HTML.
    await page.goto("/");
    const href = await page.locator('link[rel="icon"]').first().getAttribute("href");
    expect(decodeURIComponent(href)).toContain("fill='#f5a623'");
    expect(decodeURIComponent(href)).toContain("stroke='#241500'");
    expect(href).not.toContain("%E2%97%8E"); // the ◎ character, percent-encoded
  });
});

test.describe("the logo cannot be copied", () => {
  test("there is no text in the badge to select", async ({ page }) => {
    await page.goto("/");
    const badge = page.locator("h1 span").first();
    expect(await badge.evaluate((el) => el.textContent)).toBe("");
    expect(await badge.locator("svg").count(), "an inline svg, so no image to right-click and save").toBe(1);
  });

  test("selecting the header picks up nothing", async ({ page }) => {
    // What a triple-click or a drag across the title does. It used to yield "◎ prove it!".
    await page.goto("/");
    const selected = await page.evaluate(() => {
      const h = document.querySelector("h1");
      const r = document.createRange();
      r.selectNodeContents(h);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return String(s);
    });
    expect(selected.trim()).toBe("");
  });

  test("the mark is hidden from assistive tech, since the wordmark says the name", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1 span").first()).toHaveAttribute("aria-hidden", "true");
  });

  test("the mark cannot be dragged out of the page as an image", async ({ page }) => {
    // select-none was not enough, and this test is why: it governs text selection only. Both the
    // span and the svg computed `-webkit-user-drag: auto` and a dragstart fired unprevented, so the
    // logo could be dragged straight onto a desktop even with nothing selectable in it.
    await page.goto("/");
    const s = await page.locator("h1 span").first().evaluate((el) => {
      const svg = el.querySelector("svg");
      const drag = (n) => getComputedStyle(n).webkitUserDrag || "(unset)";
      return {
        spanDrag: drag(el),
        svgDrag: drag(svg),
        spanDraggable: el.draggable,
        // SVGElement has no `draggable` IDL property (that is HTMLElement), so the attribute is
        // what has to be checked here — and the attribute is what Firefox reads anyway.
        svgDraggableAttr: svg.getAttribute("draggable"),
        // A right-click landing on the <svg> is what offers "Copy image"; the plate should be the
        // hit target instead.
        svgPointerEvents: getComputedStyle(svg).pointerEvents,
      };
    });
    expect(s.spanDrag).toBe("none");
    expect(s.svgDrag).toBe("none");
    expect(s.spanDraggable).toBe(false);
    expect(s.svgDraggableAttr).toBe("false");
    expect(s.svgPointerEvents).toBe("none");
  });

  test("the logo is still clickable, so nothing above was bought with a dead control", async ({ page }) => {
    // pointer-events-none on the drawing means clicks have to pass through to the plate and to
    // whatever wraps it — the multiplayer top bar's logo is a button.
    await page.goto("/");
    const badge = page.locator("h1 span").first();
    const box = await badge.boundingBox();
    expect(box).not.toBeNull();
    const hit = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return { tag: el?.tagName?.toLowerCase(), isSvgPart: ["svg", "circle"].includes(el?.tagName?.toLowerCase()) };
    }, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(hit.isSvgPart, `a click lands on <${hit.tag}>, which must not be the drawing`).toBe(false);
  });

  test("the badge still looks like a badge — square, filled, no border", async ({ page }) => {
    // The point of the filled plate: on this app's near-black panels a dark plate would vanish and
    // leave the mark floating, which is why the amber-on-black version needed a border.
    await page.goto("/");
    const s = await page.locator("h1 span").first().evaluate((el) => {
      const c = getComputedStyle(el);
      return { bg: c.backgroundImage, border: c.borderTopWidth, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height };
    });
    expect(s.bg).toContain("245, 166, 35");
    expect(s.border).toBe("0px");
    expect(Math.abs(s.w - s.h), "square").toBeLessThan(1.5);
  });
});

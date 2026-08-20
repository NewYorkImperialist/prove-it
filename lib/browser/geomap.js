// Geography visuals for solo/daily rounds — lazy-loads D3 + TopoJSON + the atlases from a
// CDN the first time a geography round starts, so none of it lands in the main bundle.
//
//  • "map"  categories: outlined, unlabeled shapes that fill amber when named (auto-fit).
//  • Oceania: zoomed to the Australia/NZ/PNG cluster; the scattered islands become boxes.
//  • "fill" categories (World / US capitals): a grid of countries/states — type the capital.
//
// D3 owns this subtree, so the React component just hands over a container ref and calls
// these methods. Every failure path throws, and the caller falls back to the plain chip
// list — a broken CDN must never break the round.
import { CAPITALS, US_CAPITALS } from "@/data/capitals";
import { US_CATS, FILL_CATS, MAP_ONLY, geoMode } from "@/lib/geo-cats";
import { norm } from "@/lib/solo-matching";
import { PATCH, ensureLibs, getData } from "./geo-atlas.js";

// Height the fill-in box strip takes from the map when one is needed.
const BOX_STRIP_PX = 70;

// Microstates / tiny islands too small for a visible polygon → a white dot at [lng, lat].
const MICRO = {
  andorra: [1.52, 42.5], monaco: [7.42, 43.73], "san marino": [12.46, 43.94], "vatican city": [12.45, 41.9],
  liechtenstein: [9.55, 47.16], malta: [14.45, 35.9], singapore: [103.8, 1.35], bahrain: [50.55, 26.1],
  maldives: [73.5, 3.2], comoros: [43.3, -11.6], mauritius: [57.55, -20.3], seychelles: [55.5, -4.6],
  "cabo verde": [-23.6, 16.0], "sao tome and principe": [6.6, 0.3], "antigua and barbuda": [-61.8, 17.1],
  barbados: [-59.5, 13.2], dominica: [-61.37, 15.4], grenada: [-61.7, 12.1], "saint kitts and nevis": [-62.7, 17.3],
  "saint lucia": [-60.98, 13.9], "saint vincent and the grenadines": [-61.2, 13.25], "trinidad and tobago": [-61.25, 10.5],
  fiji: [178, -17.8], "solomon islands": [160, -9.6], vanuatu: [167, -16.3], samoa: [-172, -13.8],
  tonga: [-175.2, -21.2], kiribati: [173, 1.4], micronesia: [158, 6.9], "marshall islands": [171, 7.1],
  palau: [134.5, 7.5], nauru: [166.9, -0.5], tuvalu: [179.2, -8.5], bahamas: [-77.4, 24.5],
  "french guiana": [-53.1, 4.0],
};

let cur = null; // map mode: { byId: Map<entryId, { t, el, name }>, svg }
let fill = null; // fill mode: { byAlias: Map<normAlias, cell>, filled, total }
let quizTarget = null; // Borders quiz: the one shape currently highlighted as "name this one"

async function setupMap(catName, entries, container) {
  const kind = US_CATS.has(catName) ? "us" : "world";
  container.innerHTML = `<div class="geomap-msg">Loading map…</div>`;
  await ensureLibs();
  const data = await getData(kind);
  const d3 = window.d3, topojson = window.topojson;
  const fc = topojson.feature(data, data.objects[kind === "us" ? "states" : "countries"]);

  const byName = new Map();
  for (const f of fc.features) {
    const nm = norm(f.properties.name);
    byName.set(nm, f);
    const p = PATCH[nm];
    if (p) for (const a of p) byName.set(a, f);
  }

  const only = MAP_ONLY[catName];
  const mapFeats = [], boxEntries = [], featByEntry = new Map();
  for (const e of entries) {
    let f = null;
    if (!only || only.has(e.display)) {
      for (const a of e.aliases) {
        if (byName.has(a)) { f = byName.get(a); break; }
      }
    }
    if (f) { featByEntry.set(e.id, f); mapFeats.push(f); } else boxEntries.push(e);
  }
  if (!mapFeats.length) throw new Error("no shapes");

  const rect = container.getBoundingClientRect();
  const w = Math.max(240, Math.round(rect.width) || 320);
  const fullH = Math.max(160, Math.round(rect.height || 300));
  const fitted = { type: "FeatureCollection", features: mapFeats };

  // d3.geoBounds reports west > east when the smallest extent enclosing the features crosses the
  // antimeridian — which Oceania does, because New Zealand's geometry includes the Kermadec and
  // Chatham islands either side of 180°. Fitting a plain Mercator to that spans nearly the whole
  // globe: the cluster ends up crushed into one corner and the microstate dots land on the far
  // side of the canvas. Centring the projection on 180° makes the region contiguous instead.
  // Callers keep passing raw [lng, lat] — d3 applies .rotate() to its input itself.
  const bounds = d3.geoBounds(fitted);
  const wrapsAntimeridian = bounds[0][0] > bounds[1][0];
  const fit = (height) => {
    if (kind === "us") return d3.geoAlbersUsa().fitSize([w, height], fitted); // composite; can't rotate
    const proj = d3.geoMercator();
    if (wrapsAntimeridian) proj.rotate([-180, 0]);
    return proj.fitSize([w, height], fitted);
  };

  // A microstate with no polygon of its own becomes a dot when it lands inside the map, and a
  // fill-in box in a strip underneath it when it doesn't. That strip costs vertical space, so
  // classify once at full height and re-fit only when a strip turns out to be needed — the old
  // code reserved the space up front for every category with box *candidates*, which cost 70px
  // of map on lists (like Countries of the World) that end up with no boxes at all.
  const classify = (proj, height) => {
    const dots = [], boxes = [];
    for (const e of boxEntries) {
      let coord = null;
      for (const a of e.aliases) if (MICRO[a]) { coord = MICRO[a]; break; }
      const pt = coord ? proj(coord) : null;
      if (pt && pt[0] >= 0 && pt[0] <= w && pt[1] >= 0 && pt[1] <= height) dots.push({ entry: e, pt });
      else boxes.push(e);
    }
    return { dots, boxes };
  };

  let h = fullH;
  let proj = fit(h);
  let plan = classify(proj, h);
  if (plan.boxes.length) {
    h = Math.max(160, fullH - BOX_STRIP_PX);
    proj = fit(h);
    plan = classify(proj, h); // re-classify: the shorter map can push a dot out into the strip
  }
  const path = d3.geoPath(proj);

  const NS = "http://www.w3.org/2000/svg";
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "geomap-wrap";
  container.appendChild(wrap);
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("class", "geomap-svg");
  wrap.appendChild(svg);
  const g = document.createElementNS(NS, "g");
  svg.appendChild(g);

  const byId = new Map();
  for (const e of entries) {
    const f = featByEntry.get(e.id);
    if (!f) continue;
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", path(f) || "");
    p.setAttribute("class", "geomap-c");
    g.appendChild(p);
    byId.set(e.id, { t: "path", el: p });
  }
  for (const { entry, pt } of plan.dots) {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", pt[0]);
    c.setAttribute("cy", pt[1]);
    c.setAttribute("r", 3.2);
    c.setAttribute("class", "geodot");
    g.appendChild(c);
    byId.set(entry.id, { t: "dot", el: c });
  }
  // Pan + zoom (pinch on touch, wheel/drag on desktop) so tiny countries stay reachable.
  try {
    const zoom = d3.zoom().scaleExtent([1, 14]).translateExtent([[0, 0], [w, h]])
      .on("zoom", (ev) => g.setAttribute("transform", ev.transform.toString()));
    d3.select(svg).call(zoom).on("dblclick.zoom", () => d3.select(svg).transition().duration(250).call(zoom.transform, d3.zoomIdentity));
    svg.style.touchAction = "none";
    svg.style.cursor = "grab";
  } catch {
    /* zoom is a nice-to-have; the static map still works */
  }
  if (plan.boxes.length) {
    const boxes = document.createElement("div");
    boxes.className = "geomap-boxes";
    container.appendChild(boxes);
    for (const e of plan.boxes) {
      const b = document.createElement("div");
      b.className = "geobox";
      boxes.appendChild(b);
      byId.set(e.id, { t: "box", el: b, name: e.display });
    }
  }
  cur = { byId, svg, boxStrip: container.querySelector(".geomap-boxes") };
  return "map";
}

function setupFill(catName, container) {
  const data = FILL_CATS[catName] === "us" ? US_CAPITALS : CAPITALS;
  if (!data) throw new Error("no capitals data");
  const prompts = Object.keys(data).sort();
  container.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "geofill";
  const byAlias = new Map();
  for (const p of prompts) {
    const rec = data[p];
    const cell = document.createElement("div");
    cell.className = "geofill-cell";
    const ps = document.createElement("span");
    ps.className = "gf-p";
    ps.textContent = p;
    const as = document.createElement("span");
    as.className = "gf-a";
    as.textContent = "—";
    cell.appendChild(ps);
    cell.appendChild(as);
    grid.appendChild(cell);
    const c = { el: cell, slot: as, prompt: p, cap: rec.c, filled: false };
    for (const a of rec.a) byAlias.set(a, c);
  }
  container.appendChild(grid);
  fill = { byAlias, filled: 0, total: prompts.length };
  return "fill";
}

export const GeoMap = {
  mode: geoMode,
  supports: (catName) => geoMode(catName) !== null,

  async setup(catName, entries, container, named) {
    cur = null;
    fill = null;
    quizTarget = null;
    if (geoMode(catName) === "fill") return setupFill(catName, container);
    const r = await setupMap(catName, entries, container);
    if (named) named.forEach((id) => GeoMap.light(id)); // catch up anything named while it loaded
    return r;
  },

  light(entryId) {
    if (!cur) return;
    const o = cur.byId.get(entryId);
    if (!o) return;
    o.el.classList.add("lit");
    if (o.t === "box") o.el.textContent = o.name;
  },

  // Borders quiz: highlight exactly one shape as the current target, distinct from "lit"
  // (already solved). Pass null to clear it (e.g. when the round ends).
  highlight(entryId) {
    if (!cur) return;
    if (quizTarget) quizTarget.el.classList.remove("quiz-target");
    quizTarget = entryId == null ? null : cur.byId.get(entryId) || null;
    if (quizTarget) {
      quizTarget.el.classList.add("quiz-target");
      try {
        quizTarget.el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      } catch {
        /* not every browser supports scrollIntoView on an SVG element — not worth a fallback */
      }
    }
  },

  // How many shapes/dots/boxes are still un-named (map mode).
  remaining() {
    if (!cur) return 0;
    let n = 0;
    for (const o of cur.byId.values()) if (!o.el.classList.contains("lit")) n++;
    return n;
  },

  // Highlight everything NOT yet named, so you can spot what's left.
  toggleRemaining(on) {
    if (!cur || !cur.svg) return false;
    cur.svg.classList.toggle("showrem", on);
    if (cur.boxStrip) cur.boxStrip.classList.toggle("showrem", on); // islands count as "left" too
    return on;
  },

  tryFill(text) {
    if (!fill) return "miss";
    const c = fill.byAlias.get(norm(text));
    if (!c) return "miss";
    if (c.filled) return "dup";
    c.filled = true;
    c.el.classList.add("lit");
    c.slot.textContent = c.cap;
    fill.filled++;
    return "ok";
  },

  filled: () => (fill ? fill.filled : 0),
  total: () => (fill ? fill.total : 0),

  // Fill mode (capitals): the country/state → capital pairs you didn't get, for practice.
  missedFill() {
    if (!fill) return [];
    const seen = new Set(), out = [];
    for (const c of fill.byAlias.values()) {
      if (c.filled || seen.has(c)) continue;
      seen.add(c);
      out.push({ q: c.prompt, a: c.cap });
    }
    return out;
  },

  teardown() {
    cur = null;
    fill = null;
    quizTarget = null;
  },
};

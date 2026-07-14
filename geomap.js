// geomap.js — geography visuals for solo/daily rounds (lazy-loads D3 + TopoJSON + atlases from a CDN).
//  • "map"  categories: outlined, unlabeled shapes that fill orange when named (auto-zoomed to fit).
//  • Oceania: zoomed to the Australia/NZ/PNG cluster; the scattered island nations show as fill-in boxes.
//  • "fill" categories (World / US capitals): a big list of countries/states — type the capital to fill it in.
// Everything is wrapped so any failure falls back to the normal chip list (never breaks the game).
(function () {
  const CDN = {
    d3: "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js",
    topojson: "https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js",
    world: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json",
    us: "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
  };
  const WORLD_CATS = new Set(["Countries of the World", "Countries in Europe", "Countries in Asia", "Countries in Africa", "Countries in South America", "Countries in Oceania", "Countries in North America", "Countries in Central America", "European Union Members", "Countries in the Middle East"]);
  const US_CATS = new Set(["US States"]);
  const FILL_CATS = { "World Capitals": "world", "US State Capitals": "us" }; // type the capital to fill each country/state
  const MAP_ONLY = { "Countries in Oceania": new Set(["Australia", "New Zealand", "Papua New Guinea"]) }; // rest become islands boxes
  const PATCH = {
    "bosnia and herz.": ["bosnia and herzegovina", "bosnia"], "central african rep.": ["central african republic"],
    "dem. rep. congo": ["dr congo", "democratic republic of the congo", "drc"], "congo": ["republic of the congo", "congo"],
    "eq. guinea": ["equatorial guinea"], "s. sudan": ["south sudan"], "dominican rep.": ["dominican republic"],
    "solomon is.": ["solomon islands"], "marshall is.": ["marshall islands"], "antigua and barb.": ["antigua and barbuda"],
    "st. kitts and nevis": ["saint kitts and nevis", "st kitts and nevis"], "united states of america": ["united states", "usa", "america", "us"],
    "macedonia": ["north macedonia"], "cote d'ivoire": ["ivory coast"], "eswatini": ["swaziland"],
  };
  const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

  let libsReady = false;
  const dataCache = {};
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src)); document.head.appendChild(s); }); }
  async function ensureLibs() { if (libsReady && window.d3 && window.topojson) return; if (!window.d3) await loadScript(CDN.d3); if (!window.topojson) await loadScript(CDN.topojson); libsReady = true; }
  async function getData(kind) { if (dataCache[kind]) return dataCache[kind]; dataCache[kind] = await (await fetch(kind === "us" ? CDN.us : CDN.world)).json(); return dataCache[kind]; }

  function catMode(catName) { if (FILL_CATS[catName]) return "fill"; if (WORLD_CATS.has(catName) || US_CATS.has(catName)) return "map"; return null; }

  let cur = null;   // map mode: { byId: Map<entryId, {t:"path"|"box", el, name}> }
  let fill = null;  // fill mode: { byAlias: Map<normAlias, cell>, filled, total }

  async function setupMap(catName, entries, container) {
    const kind = US_CATS.has(catName) ? "us" : "world";
    container.innerHTML = `<div class="geomap-msg">Loading map…</div>`;
    await ensureLibs();
    const data = await getData(kind);
    const d3 = window.d3, topojson = window.topojson;
    const fc = topojson.feature(data, data.objects[kind === "us" ? "states" : "countries"]);
    const byName = new Map();
    for (const f of fc.features) { const nm = norm(f.properties.name); byName.set(nm, f); const p = PATCH[nm]; if (p) for (const a of p) byName.set(a, f); }
    const only = MAP_ONLY[catName];
    const mapFeats = [], boxEntries = [], featByEntry = new Map();
    for (const e of entries) {
      let f = null;
      if (!only || only.has(e.display)) for (const a of e.aliases) { if (byName.has(a)) { f = byName.get(a); break; } }
      if (f) { featByEntry.set(e.id, f); mapFeats.push(f); } else boxEntries.push(e);
    }
    if (!mapFeats.length) throw new Error("no shapes");
    const rect = container.getBoundingClientRect();
    const w = Math.max(240, Math.round(rect.width) || 320), h = Math.max(160, Math.round((rect.height || 300)) - (boxEntries.length ? 70 : 0));
    const proj = (kind === "us" ? d3.geoAlbersUsa() : d3.geoMercator()).fitSize([w, h], { type: "FeatureCollection", features: mapFeats });
    const path = d3.geoPath(proj);
    const NS = "http://www.w3.org/2000/svg";
    container.innerHTML = "";
    const wrap = document.createElement("div"); wrap.className = "geomap-wrap"; container.appendChild(wrap);
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.setAttribute("preserveAspectRatio", "xMidYMid meet"); svg.setAttribute("class", "geomap-svg"); wrap.appendChild(svg);
    const byId = new Map();
    for (const e of entries) { const f = featByEntry.get(e.id); if (!f) continue; const p = document.createElementNS(NS, "path"); p.setAttribute("d", path(f) || ""); p.setAttribute("class", "geomap-c"); svg.appendChild(p); byId.set(e.id, { t: "path", el: p }); }
    if (boxEntries.length) {
      const boxes = document.createElement("div"); boxes.className = "geomap-boxes"; container.appendChild(boxes);
      for (const e of boxEntries) { const b = document.createElement("div"); b.className = "geobox"; boxes.appendChild(b); byId.set(e.id, { t: "box", el: b, name: e.display }); }
    }
    cur = { byId };
    return "map";
  }

  function setupFill(catName, container) {
    const data = FILL_CATS[catName] === "us" ? window.US_CAPITALS : window.CAPITALS;
    if (!data) throw new Error("no capitals data");
    const prompts = Object.keys(data).sort();
    container.innerHTML = "";
    const grid = document.createElement("div"); grid.className = "geofill";
    const byAlias = new Map();
    for (const p of prompts) {
      const rec = data[p];
      const cell = document.createElement("div"); cell.className = "geofill-cell";
      const ps = document.createElement("span"); ps.className = "gf-p"; ps.textContent = p;
      const as = document.createElement("span"); as.className = "gf-a"; as.textContent = "—";
      cell.appendChild(ps); cell.appendChild(as); grid.appendChild(cell);
      const c = { el: cell, slot: as, cap: rec.c, filled: false };
      for (const a of rec.a) byAlias.set(a, c);
    }
    container.appendChild(grid);
    fill = { byAlias, filled: 0, total: prompts.length };
    return "fill";
  }

  const api = {
    mode: catMode,
    supports(catName) { return catMode(catName) !== null; },
    async setup(catName, entries, container, named) {
      cur = null; fill = null;
      if (catMode(catName) === "fill") return setupFill(catName, container);
      const r = await setupMap(catName, entries, container);
      if (named) named.forEach((id) => api.light(id)); // catch up anything named while the map loaded
      return r;
    },
    light(entryId) { if (cur) { const o = cur.byId.get(entryId); if (o) { o.el.classList.add("lit"); if (o.t === "box") o.el.textContent = o.name; } } },
    tryFill(text) {
      if (!fill) return "miss";
      const c = fill.byAlias.get(norm(text));
      if (!c) return "miss";
      if (c.filled) return "dup";
      c.filled = true; c.el.classList.add("lit"); c.slot.textContent = c.cap; fill.filled++;
      return "ok";
    },
    filled() { return fill ? fill.filled : 0; },
    total() { return fill ? fill.total : 0; },
    teardown() { cur = null; fill = null; },
  };
  window.GeoMap = api;
})();

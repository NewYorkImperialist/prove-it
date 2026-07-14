// geomap.js — lights up an outlined, unlabeled map for geography solo/daily rounds.
// Lazy-loads D3 + TopoJSON + map data from a CDN on the first geography round (cached after).
// Renders only the round's answer shapes, zoomed to fit; each fills orange when named.
// Everything is wrapped so any failure falls back to the normal chips (never breaks the game).
(function () {
  const CDN = {
    d3: "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js",
    topojson: "https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js",
    world: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json",
    us: "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
  };
  const WORLD_CATS = new Set(["Countries of the World", "Countries in Europe", "Countries in Asia", "Countries in Africa", "Countries in South America", "Countries in Oceania"]);
  const US_CATS = new Set(["US States"]);
  // Feature name (normalized, as it appears in the dataset) → extra answer aliases to accept.
  const PATCH = {
    "bosnia and herz.": ["bosnia and herzegovina", "bosnia"],
    "central african rep.": ["central african republic"],
    "dem. rep. congo": ["dr congo", "democratic republic of the congo", "drc"],
    "congo": ["republic of the congo", "congo"],
    "eq. guinea": ["equatorial guinea"],
    "s. sudan": ["south sudan"],
    "dominican rep.": ["dominican republic"],
    "solomon is.": ["solomon islands"],
    "marshall is.": ["marshall islands"],
    "antigua and barb.": ["antigua and barbuda"],
    "st. kitts and nevis": ["saint kitts and nevis", "st kitts and nevis"],
    "united states of america": ["united states", "usa", "america", "us"],
    "macedonia": ["north macedonia"],
    "cote d'ivoire": ["ivory coast"],
    "eswatini": ["swaziland"],
  };
  const norm = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().replace(/\s+/g, " ");

  let libsReady = false;
  const dataCache = {};
  function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load " + src)); document.head.appendChild(s); }); }
  async function ensureLibs() {
    if (libsReady && window.d3 && window.topojson) return;
    if (!window.d3) await loadScript(CDN.d3);
    if (!window.topojson) await loadScript(CDN.topojson);
    libsReady = true;
  }
  async function getData(kind) { if (dataCache[kind]) return dataCache[kind]; dataCache[kind] = await (await fetch(kind === "us" ? CDN.us : CDN.world)).json(); return dataCache[kind]; }

  let cur = null; // { byId: Map<entryId, pathEl> }

  const api = {
    supports(catName) { return WORLD_CATS.has(catName) || US_CATS.has(catName); },
    // Build the map for a round. entries = category entries ({id, display, aliases}); named = Set of already-named ids.
    // Returns true on success; throws on failure so the caller can fall back to chips.
    async setup(catName, entries, container, named) {
      cur = null;
      const kind = US_CATS.has(catName) ? "us" : "world";
      container.innerHTML = `<div class="geomap-msg">Loading map…</div>`;
      await ensureLibs();
      const data = await getData(kind);
      const d3 = window.d3, topojson = window.topojson;
      const objName = kind === "us" ? "states" : "countries";
      const fc = topojson.feature(data, data.objects[objName]);
      const byName = new Map();
      for (const f of fc.features) { const nm = norm(f.properties.name); byName.set(nm, f); const p = PATCH[nm]; if (p) for (const a of p) byName.set(a, f); }
      const featByEntry = new Map(), wanted = [];
      for (const e of entries) { let f = null; for (const a of e.aliases) { if (byName.has(a)) { f = byName.get(a); break; } } if (f) { featByEntry.set(e.id, f); wanted.push(f); } }
      if (!wanted.length) throw new Error("no shapes for this category");
      const rect = container.getBoundingClientRect();
      const w = Math.max(240, Math.round(rect.width) || 320), h = Math.max(160, Math.round(rect.height) || 280);
      const proj = (kind === "us" ? d3.geoAlbersUsa() : d3.geoMercator()).fitSize([w, h], { type: "FeatureCollection", features: wanted });
      const path = d3.geoPath(proj);
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.setAttribute("preserveAspectRatio", "xMidYMid meet"); svg.setAttribute("class", "geomap-svg");
      const byId = new Map();
      for (const e of entries) { const f = featByEntry.get(e.id); if (!f) continue; const p = document.createElementNS(NS, "path"); p.setAttribute("d", path(f) || ""); p.setAttribute("class", "geomap-c"); svg.appendChild(p); byId.set(e.id, p); }
      container.innerHTML = ""; container.appendChild(svg);
      cur = { byId };
      if (named) named.forEach((id) => api.light(id)); // catch up anything named while it was loading
      return true;
    },
    light(entryId) { if (cur) { const p = cur.byId.get(entryId); if (p) p.classList.add("lit"); } },
    teardown() { cur = null; },
  };
  window.GeoMap = api;
})();

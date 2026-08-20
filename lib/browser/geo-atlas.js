// Shared plumbing for anything that needs real country/state boundary data: lazy-loads D3 +
// TopoJSON + the atlas itself from a CDN (so none of it lands in the main bundle), and the
// name patches that bridge the atlas's abbreviated country names to our answer lists' aliases.
// Used by lib/browser/geomap.js — the Borders quiz is just "map" mode for a Borders category
// name now (see lib/geo-cats.js), so it's the only consumer, but the name-patch table stays
// here rather than back in geomap.js in case that changes again.
export const CDN = {
  d3: "https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js",
  topojson: "https://cdn.jsdelivr.net/npm/topojson-client@3/dist/topojson-client.min.js",
  world: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json",
  us: "https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json",
};

// The atlases spell some countries differently than our answer lists do.
export const PATCH = {
  "bosnia and herz.": ["bosnia and herzegovina", "bosnia"],
  "central african rep.": ["central african republic"],
  "dem. rep. congo": ["dr congo", "democratic republic of the congo", "drc"],
  congo: ["republic of the congo", "congo"],
  "eq. guinea": ["equatorial guinea"],
  "s. sudan": ["south sudan"],
  "dominican rep.": ["dominican republic"],
  "solomon is.": ["solomon islands"],
  "marshall is.": ["marshall islands"],
  "antigua and barb.": ["antigua and barbuda"],
  "st. kitts and nevis": ["saint kitts and nevis", "st kitts and nevis"],
  "united states of america": ["united states", "usa", "america", "us"],
  macedonia: ["north macedonia"],
  "cote d'ivoire": ["ivory coast"],
  eswatini: ["swaziland"],
  "st. vin. and gren.": ["saint vincent and the grenadines", "st vincent and the grenadines", "st vincent"],
};

let libsReady = false;
const dataCache = {};

const loadScript = (src) =>
  new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error("load " + src));
    document.head.appendChild(s);
  });

export async function ensureLibs() {
  if (libsReady && window.d3 && window.topojson) return;
  if (!window.d3) await loadScript(CDN.d3);
  if (!window.topojson) await loadScript(CDN.topojson);
  libsReady = true;
}

export async function getData(kind) {
  if (dataCache[kind]) return dataCache[kind];
  dataCache[kind] = await (await fetch(kind === "us" ? CDN.us : CDN.world)).json();
  return dataCache[kind];
}

// Country-outline rendering for the Silhouette quiz: one country's shape at a time, auto-fit
// and centered, no neighbors, no labels. Reuses the same lazy-loaded topojson world atlas the
// geography map uses (lib/browser/geo-atlas.js) — this just projects a single feature to its
// own tile instead of the whole world at once, so even a tiny country still fills its cell.
import { featuresByName } from "./geo-atlas.js";

// One SVG path string per entry, fit to w×h — null for the rare entry with no polygon in the
// atlas at this resolution (see lib/silhouettes.js for which ones those are and why).
export async function silhouettePaths(entries, w, h) {
  const byName = await featuresByName("world");
  const d3 = window.d3;
  const out = new Map();
  for (const e of entries) {
    let f = null;
    for (const a of e.aliases) {
      if (byName.has(a)) { f = byName.get(a); break; }
    }
    out.set(e.id, f ? d3.geoPath(d3.geoMercator().fitSize([w, h], f))(f) : null);
  }
  return out;
}

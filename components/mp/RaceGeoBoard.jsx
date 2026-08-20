"use client";
import { useEffect, useRef, useState } from "react";
import { findCat } from "@/lib/solo-catalog";
import { norm } from "@/lib/solo-matching";

// Resolve a canonical answer back to its catalogue entry, so map mode knows which shape to
// light. The server sends only the display string; ids are positional and the two builders
// (lib/answer-matching.js and lib/solo-catalog.js) walk items in the same order, but matching
// locally on the name is one less thing that can silently drift.
function findEntry(cat, display) {
  const q = norm(display);
  return cat.entries.find((e) => e.display === display) || cat.entries.find((e) => e.aliases.includes(q)) || null;
}

// Challenge Race's geography board — the same one solo draws. Only ever fed *my* answers:
// opponents' don't reach the client until every clock is spent, so nothing here can leak them.
export default function RaceGeoBoard({ catName, mode, round, mine }) {
  const el = useRef(null);
  const geo = useRef(null);
  const applied = useRef(0);
  const [ready, setReady] = useState(0); // bumped once a board is drawn, so the sync effect runs
  const [failed, setFailed] = useState(false);
  const cat = findCat(catName);

  useEffect(() => {
    if (!cat || !el.current) return undefined;
    let cancelled = false;
    applied.current = 0;
    setFailed(false);
    (async () => {
      try {
        const mod = await import("@/lib/browser/geomap");
        if (cancelled || !el.current) return;
        geo.current = mod.GeoMap;
        await mod.GeoMap.setup(cat.name, cat.entries, el.current, null);
        if (cancelled) return;
        setReady((n) => n + 1);
      } catch {
        // CDN down, or no shapes for this list: drop the board and let the feed have the room.
        if (cancelled) return;
        geo.current = null;
        if (el.current) el.current.innerHTML = "";
        setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      geo.current?.teardown();
    };
    // `round` is a dep on purpose: a fresh round redraws even when the category repeats.
  }, [catName, mode, round, cat]);

  // Mark everything I've named that the board hasn't seen yet. Runs after setup too, so answers
  // typed while the atlas was still downloading are caught up rather than lost.
  useEffect(() => {
    if (!ready || !geo.current || !cat) return;
    for (let i = applied.current; i < mine.length; i++) {
      if (mode === "fill") geo.current.tryFill(mine[i]);
      else {
        const e = findEntry(cat, mine[i]);
        if (e) geo.current.light(e.id);
      }
    }
    applied.current = mine.length;
  }, [ready, mine, mode, cat]);

  if (!cat) return null;
  // The board is drawn from CDN-hosted atlases, so it can fail on a round that is otherwise
  // running normally. Returning null just made it disappear; the race is still playable by
  // typing, so say that instead of leaving a hole where the map was.
  if (failed) {
    return (
      <p className="mx-3 my-1.5 text-[13px] text-gold desk:mx-5">
        Couldn&apos;t load the map for this round — your answers still count, so keep typing.
      </p>
    );
  }
  // D3 owns this node, so React must not render children into it. A column: the map takes the
  // free space, the island fill-in boxes sit underneath it.
  // short: a landscape phone matches `desk:` on width but is only ~390px tall, where reserving
  // 200px for the board leaves nothing for the feed and the input bar.
  return <div ref={el} className="mx-3 my-1.5 flex min-h-[150px] min-w-0 flex-1 flex-col desk:mx-5 desk:my-2 desk:min-h-[200px] short:my-1 short:min-h-[130px]" />;
}

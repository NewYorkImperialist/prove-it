"use client";
import { useEffect, useRef, useState } from "react";
import { borderPaths } from "@/lib/browser/border-map";
import { cx } from "@/lib/browser/cx";

const TILE = 80; // px — the box each outline is fit into, same units the path data is computed in

// The Borders quiz board: same grid/highlight/click-to-select shape as FlagBoard, but the image
// per tile is a country outline computed client-side from the real world atlas (see
// lib/browser/border-map.js) instead of a static flag URL — so it loads once, asynchronously,
// for the whole round rather than being ready immediately.
export default function BorderBoard({ entries, selected, namedIds, onSelect }) {
  const [paths, setPaths] = useState(null); // Map<entryId, pathString|null>, or null while loading
  const [failed, setFailed] = useState(false);
  const selRef = useRef(null);

  useEffect(() => {
    let live = true;
    setPaths(null);
    setFailed(false);
    borderPaths(entries, TILE, TILE)
      .then((m) => live && setPaths(m))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [entries]);

  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected]);

  if (failed) return <div className="my-2 rounded-xl border border-line2 bg-bg p-6 text-center text-sm text-muted">Couldn&apos;t load the map data for this round — try again in a moment.</div>;
  if (!paths) return <div className="my-2 rounded-xl border border-line2 bg-bg p-6 text-center text-sm text-muted">Loading outlines…</div>;

  return (
    <div className="my-2 grid min-h-0 flex-1 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-line2 bg-bg p-2 desk:grid-cols-8">
      {entries.map((e, i) => {
        const isSel = i === selected;
        const solved = namedIds.has(e.id);
        const d = paths.get(e.id);
        return (
          <button
            key={e.id}
            type="button"
            ref={isSel ? selRef : null}
            onMouseDown={(ev) => ev.preventDefault()} // stay focused on the text input, not the button
            onClick={() => onSelect(i)}
            className={cx(
              "flex h-fit flex-col items-center gap-1 rounded-lg border p-1.5 transition-colors",
              isSel ? "border-accent bg-accdim" : solved ? "border-line2 bg-panel opacity-60" : "border-line2 bg-panel hover:border-accent/60",
            )}
          >
            <svg viewBox={`0 0 ${TILE} ${TILE}`} className="w-full">
              {d ? <path d={d} className="fill-ink" /> : null}
            </svg>
            <span className="h-[14px] w-full truncate text-center text-[10px] text-muted">{solved ? e.display : ""}</span>
          </button>
        );
      })}
    </div>
  );
}

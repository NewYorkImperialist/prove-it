"use client";
import { useEffect, useRef } from "react";
import { flagUrl } from "@/lib/flags";
import { cx } from "@/lib/browser/cx";

// The Flags quiz board: every flag in the category, in a grid. One is highlighted at a time —
// arrow keys (handled by SprintSection's input) or a click move the highlight; solved flags
// reveal their name and dim. There's no click-to-answer here, only click-to-select.
export default function FlagBoard({ entries, selected, namedIds, onSelect }) {
  const selRef = useRef(null);

  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected]);

  return (
    <div className="my-2 grid min-h-0 flex-1 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-line2 bg-bg p-2 desk:grid-cols-8">
      {entries.map((e, i) => {
        const isSel = i === selected;
        const solved = namedIds.has(e.id);
        return (
          <button
            key={e.id}
            type="button"
            ref={isSel ? selRef : null}
            onMouseDown={(e) => e.preventDefault()} // stay focused on the text input, not the button
            onClick={() => onSelect(i)}
            className={cx(
              "flex h-fit flex-col items-center gap-1 rounded-lg border p-1.5 transition-colors",
              isSel ? "border-accent bg-accdim" : solved ? "border-line2 bg-panel opacity-60" : "border-line2 bg-panel hover:border-accent/60",
            )}
          >
            <img src={flagUrl(e.flagCode)} alt="" className="w-full rounded-sm shadow-sm" draggable={false} />
            <span className="h-[14px] w-full truncate text-center text-[10px] text-muted">{solved ? e.display : ""}</span>
          </button>
        );
      })}
    </div>
  );
}

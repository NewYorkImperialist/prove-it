"use client";
import { useEffect, useRef } from "react";
import { flagUrl } from "@/lib/flags";
import { cx } from "@/lib/browser/cx";

// The Flags quiz board: every flag in the category, in a grid. One is highlighted at a time —
// arrow keys (handled by SprintSection's input) or a click move the highlight; solved flags
// reveal their name and dim. There's no click-to-answer here, only click-to-select.
export default function FlagBoard({ entries, selected, namedIds, onSelect, onUnavailable }) {
  const selRef = useRef(null);
  // flagcdn is a third party, and with no images this board shows nothing to identify while every
  // guess still comes back "that's on the list, but not this one" — measured against a flag the
  // player can't see. Counting failures rather than reacting to the first one keeps a single
  // missing SVG (one country) from claiming the whole round is unplayable.
  const failed = useRef(new Set());
  const reported = useRef(false);

  // The highlighted flag is always brought into view, which is what makes a short grid workable:
  // the board can be only a row and a bit tall (see the `short:` floor below) and the flag you're
  // being asked about is still on screen.
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [selected]);

  // Reset when the round changes, or a previous round's failures would carry over.
  useEffect(() => {
    failed.current = new Set();
    reported.current = false;
  }, [entries]);

  const noteFailure = (id) => {
    failed.current.add(id);
    if (reported.current || !onUnavailable) return;
    // Enough of the grid is missing that there's no question left to answer.
    if (failed.current.size >= Math.min(4, entries.length)) {
      reported.current = true;
      onUnavailable();
    }
  };

  return (
    <div className="my-2 grid min-h-[150px] flex-1 grid-cols-4 gap-2 overflow-y-auto rounded-xl border border-line2 bg-bg p-2 short:my-1 short:min-h-[96px] desk:grid-cols-8">
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
            <img
              src={flagUrl(e.flagCode)}
              alt=""
              className="w-full rounded-sm shadow-sm"
              draggable={false}
              onError={() => noteFailure(e.id)}
            />
            <span className="h-[14px] w-full truncate text-center text-[10px] text-muted">{solved ? e.display : ""}</span>
          </button>
        );
      })}
    </div>
  );
}

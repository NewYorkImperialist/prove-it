"use client";
import { Crown } from "@/components/ui/Logo";
import { cx } from "@/lib/browser/cx";

// The one table skin every board shares: mono uppercase headers, right-aligned numbers,
// the player column in the display face, and the viewer's own row tinted amber.
export function LbTable({ head, children }) {
  return (
    // A 10-round board is 13 columns and ~730px wide, which no phone fits. The horizontal
    // scroller has to be THIS wrapper: when the modal body did the scrolling instead, the close
    // button and the tabs (absolutely positioned inside it) slid away with the table, so reaching
    // the Score column meant losing every control. `w-max min-w-full` lets the table exceed the
    // wrapper instead of squeezing its columns to nothing.
    <div className="-mx-1 mt-2 overflow-x-auto overscroll-x-contain px-1">
      <table className="w-max min-w-full border-collapse text-sm">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                title={h.title}
                className={cx(
                  "border-b border-line2 px-[9px] py-[7px] font-mono text-[10px] tracking-[.6px] text-muted uppercase",
                  i === 0 ? "text-left" : "text-right",
                )}
              >
                {h.label ?? h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function LbRow({ mine, children }) {
  return <tr className={cx(mine && "[&>td]:bg-accdim")}>{children}</tr>;
}

const CELL = "border-b border-line px-[9px] py-2 text-right font-semibold text-muted tabular-nums";

export function LbCell({ children, highlight = false, className }) {
  return <td className={cx(CELL, highlight && "font-extrabold text-accent", className)}>{children}</td>;
}

// The player-name cell: display face, left-aligned, with the crown and a "(you)" marker.
export function LbName({ name, crown, mine }) {
  return (
    <td className={cx(CELL, "text-left font-display text-[15px] tracking-[-.2px] text-ink")}>
      {name || "?"}
      {crown ? <Crown small /> : null}
      {mine ? " (you)" : ""}
    </td>
  );
}

export function LbTotal({ children }) {
  return <td className={cx(CELL, "text-[15px] font-extrabold text-ink")}>{children}</td>;
}

export function LbNote({ children, className }) {
  return <p className={cx("mt-3 mb-0 text-[13px] text-muted", className)}>{children}</p>;
}

"use client";
import { Crown } from "@/components/ui/Logo";
import { cx } from "@/lib/browser/cx";

// The one table skin every board shares: mono uppercase headers, right-aligned numbers,
// the player column in the display face, and the viewer's own row tinted amber.
export function LbTable({ head, children }) {
  return (
    <table className="mt-2 w-full border-collapse text-sm">
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

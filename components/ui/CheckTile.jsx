"use client";
import { cx } from "@/lib/browser/cx";

// One category-group checkbox. Used in the lobby grid and the in-game category menu.
export default function CheckTile({ checked, onChange, emoji, label, disabled = false, className }) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-center gap-2.5 rounded-[10px] border bg-panel2 px-3 py-2.5 transition duration-[120ms] select-none hover:border-accent",
        checked ? "border-accent bg-accdim" : "border-line",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="m-0 h-4 w-4 border-none bg-transparent p-0 accent-accent"
      />
      {emoji ? <span className="text-lg">{emoji}</span> : null}
      <span className="text-sm">{label}</span>
    </label>
  );
}

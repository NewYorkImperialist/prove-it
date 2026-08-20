"use client";
import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/browser/cx";

// A row of mutually-exclusive buttons (timer, win-at, match format, …).
// options: [{ value, label }]; `value` is compared with Object.is so null works as a value.
export default function Seg({ options, value, onChange, disabled = false, className }) {
  return (
    <div className={cx("flex gap-2", className)}>
      {options.map((o) => {
        const on = Object.is(o.value, value);
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cx(
              // min-w-0 lets a five-option row (the solo time presets) actually fit a 320px card
              // instead of sliding its last button off the edge of the screen; the padding gives
              // way before the row does.
              "min-w-0 flex-1 cursor-pointer rounded-[10px] border px-1.5 py-[11px] text-sm font-bold transition duration-[120ms] min-[380px]:px-[11px]",
              on ? "border-accent bg-accent text-markfg" : "border-line bg-panel2 text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// −/+ stepper with a numeric field, for any value the presets don't cover.
export function Stepper({ value, onChange, min = 0, max = 30, step = 1, unit = "seconds", ariaLess = "less", ariaMore = "more" }) {
  const clamp = (n) => Math.max(min, Math.min(max, n));
  // What's in the box while it's being typed into. Clamping on every keystroke rewrote the
  // first digit of anything starting below `min` — typing 120 with min 5 gave "5", then "52",
  // then "520", so a 2-minute round was untypable and the player silently got 8m40 instead.
  // The draft is only clamped when they're done (blur / Enter), so the committed value is
  // still always in range.
  const [draft, setDraft] = useState(null);
  const inputRef = useRef(null);
  // Presets and the buttons change `value` under us; drop a half-typed draft when they do.
  useEffect(() => setDraft(null), [value]);

  const commit = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    if (!isNaN(n)) onChange(clamp(n)); // an empty / non-numeric draft just reverts
    setDraft(null);
  };
  // The buttons and the arrow keys step immediately, from whatever is on screen (draft
  // included) rather than from the last committed value — clicking + after typing 120 must
  // give 125, not 50.
  const stepBy = (d) => {
    const n = parseInt(inputRef.current ? inputRef.current.value : "", 10);
    onChange(clamp((isNaN(n) ? value : n) + d));
    setDraft(null);
  };

  const btn = "h-[42px] w-[42px] shrink-0 cursor-pointer rounded-[10px] border border-line2 bg-panel2 p-0 text-[22px] font-bold text-ink hover:border-accent hover:text-accent";
  return (
    <div className="mt-2 flex items-center gap-2">
      <button type="button" aria-label={ariaLess} className={btn} onClick={() => stepBy(-step)}>
        −
      </button>
      <input
        ref={inputRef}
        type="number"
        min={min}
        max={max}
        step={step}
        inputMode="numeric"
        value={draft === null ? String(value) : draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") return commit();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault(); // the browser's own arrow stepping would edit the draft instead
            stepBy(e.key === "ArrowUp" ? step : -step);
          }
        }}
        className="w-[84px] shrink-0 rounded-[10px] border border-line bg-bg px-1.5 py-3 text-center text-[15px] text-ink tabular-nums outline-none focus:border-accent"
      />
      <span className="text-[13px] text-muted">{unit}</span>
      <button type="button" aria-label={ariaMore} className={btn} onClick={() => stepBy(step)}>
        +
      </button>
    </div>
  );
}

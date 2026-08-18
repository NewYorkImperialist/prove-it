"use client";
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
              "flex-1 cursor-pointer rounded-[10px] border p-[11px] text-sm font-bold transition duration-[120ms]",
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
  const btn = "h-[42px] w-[42px] shrink-0 cursor-pointer rounded-[10px] border border-line2 bg-panel2 p-0 text-[22px] font-bold text-ink hover:border-accent hover:text-accent";
  return (
    <div className="mt-2 flex items-center gap-2">
      <button type="button" aria-label={ariaLess} className={btn} onClick={() => onChange(clamp(value - step))}>
        −
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v)) onChange(clamp(v));
        }}
        className="w-[84px] shrink-0 rounded-[10px] border border-line bg-bg px-1.5 py-3 text-center text-[15px] text-ink tabular-nums outline-none focus:border-accent"
      />
      <span className="text-[13px] text-muted">{unit}</span>
      <button type="button" aria-label={ariaMore} className={btn} onClick={() => onChange(clamp(value + step))}>
        +
      </button>
    </div>
  );
}

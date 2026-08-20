"use client";
import { cx } from "@/lib/browser/cx";

const BASE = "cursor-pointer rounded-[10px] p-[13px] text-[15px] font-extrabold transition duration-[120ms] disabled:cursor-not-allowed disabled:opacity-40";

const VARIANTS = {
  // The one obvious next step on a card.
  primary: "mt-5 w-full bg-accent2 text-onaccent2",
  // Everything else on the same card.
  secondary: "border border-line bg-panel2 text-ink",
  // Quieter still: leave / spectate / cancel.
  ghost: "border border-line bg-transparent text-muted",
};

export default function Button({ variant = "secondary", highlight = false, className, type = "button", ...rest }) {
  return (
    <button
      type={type}
      className={cx(
        BASE,
        VARIANTS[variant],
        // Draws the eye to a freshly-shipped feature without shouting: a quiet accent
        // border and tint, no icon needed. Marked important so it beats the variant's own
        // border/background, which Tailwind would otherwise win on source order.
        highlight && "border-accent! bg-accdim!",
        className,
      )}
      {...rest}
    />
  );
}

// "New" pill that rides alongside a highlighted button's label.
export function NewTag({ children = "New" }) {
  return (
    <span className="ml-2 inline-block rounded-md bg-accent px-[7px] py-[3px] align-[2px] text-[10px] font-extrabold tracking-[.5px] text-markfg uppercase">
      {children}
    </span>
  );
}

export function BackButton({ children = "← Back", className, ...rest }) {
  return (
    <button
      type="button"
      // -ml-2 keeps it visually flush with the card's edge while the padding gives it a real
      // hit area — it was a 45×19.5 target on every setup and solo screen.
      className={cx("-ml-2 mb-2 inline-flex min-h-10 cursor-pointer items-center gap-1.5 border-none bg-transparent px-2 py-1 text-[13px] font-bold text-muted hover:text-accent", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

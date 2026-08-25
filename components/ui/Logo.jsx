"use client";
import { cx } from "@/lib/browser/cx";

// The brand mark: the dark two-circle glyph (◎) on a filled amber plate — as it has always been.
//
// Not the same way round as the home-screen icons in public/, which stay amber-on-black. That is
// intentional: an installed icon sits on the user's own wallpaper, where a solid amber square is a
// bright blob among their other apps, while this badge and the favicon sit on this app's near-black
// panels and in a browser tab strip, where the filled plate is what makes the mark findable. Being
// filled is also why it needs no border, unlike Crown below — the plate is its own edge.
//
// select-none, and nothing beyond it. The reason is aesthetic, not protective: dragging a selection
// across the page painted a highlight box over the logo, which reads as a mistake. It is still a text
// glyph and still in the document — user-select:none just excludes it from a selection, which is
// exactly the amount of "not copyable" a cosmetic problem asks for.
//
// (This was briefly an inline SVG — geometry instead of a glyph, which does render identically
// everywhere, since U+25CE lives in Noto Sans Symbols and is bundled nowhere here. It also looked
// wrong: the glyph carries a -webkit-text-stroke that thickens it, and a stroked circle matching that
// is not the same shape. lib/favicon.js keeps its geometry, because 16px in a strip of other tabs is
// where a missing glyph would actually hurt and nobody would think to check.)
export function LogoBadge({ className }) {
  return (
    <span
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-lg bg-[linear-gradient(140deg,#f5a623,#e0801a)] text-markfg leading-none [-webkit-text-stroke:.9px_#241500]",
        "h-[30px] w-[30px] text-base select-none",
        className,
      )}
    >
      ◎
    </span>
  );
}

// select-none for the same reason as the badge, and the same reason only: a highlight box across the
// brand name reads as a mistake. Selecting the header on the way to something else used to sweep it in.
export function Wordmark({ children = "prove it!", className }) {
  return <span className={cx("font-display font-bold tracking-[-.3px] select-none", className)}>{children}</span>;
}

// The flair tile around the creator's 👑, with a hover tooltip so a stray emoji reads as a badge.
export function Crown({ party = false, small = false }) {
  return (
    <span
      className={cx(
        "relative ml-[7px] inline-flex cursor-default items-center justify-center rounded-md align-middle leading-none",
        "bg-[linear-gradient(150deg,#4a3617_0%,#352712_50%,#221809_100%)] border border-[rgba(245,166,35,.6)]",
        "shadow-[0_1px_2px_rgba(0,0,0,.5),inset_0_1px_0_rgba(255,255,255,.12),0_0_7px_rgba(245,166,35,.3)]",
        small ? "h-[21px] w-[21px] text-xs" : "h-[23px] w-[23px] text-[13px]",
        "after:pointer-events-none after:absolute after:bottom-[calc(100%+7px)] after:left-1/2 after:z-[60] after:-translate-x-1/2",
        "after:rounded-md after:border after:border-line after:bg-[#0c0d10] after:px-2 after:py-[3px]",
        "after:text-[11px] after:font-bold after:tracking-[.3px] after:whitespace-nowrap after:text-white",
        "after:opacity-0 after:transition-opacity after:duration-[120ms] after:content-['Creator'] hover:after:opacity-100",
        party && "z-[60] animate-crown-party",
      )}
    >
      👑
    </span>
  );
}

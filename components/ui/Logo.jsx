"use client";
import { cx } from "@/lib/browser/cx";

// The brand mark: dark rings on a filled amber plate — the original mark, and the same way round as
// the favicon.
//
// Not the same way round as the home-screen icons in public/, which stay amber-on-black. That is
// intentional: an installed icon sits on the user's own wallpaper, where a solid amber square is a
// bright blob among their other apps, while this badge and the favicon sit on this app's near-black
// panels and in a browser tab strip, where the filled plate is what makes the mark findable. Being
// filled is also why it needs no border, unlike Crown below — the plate is its own edge.
//
// Drawn as an inline SVG rather than the "◎" character it used to be, for two reasons.
//
// It renders. U+25CE lives in Noto Sans Symbols, which this app bundles nowhere, so the glyph was at
// the mercy of whatever font the device had — the same trap scripts/make-icons.js has always avoided
// by drawing circles ("a missing glyph rasterises to a tofu box"). The geometry below is that file's
// SHAPE, unchanged, so the badge, the favicon and the installed icons are one mark at one set of
// proportions instead of three things that happen to look alike.
//
// And it isn't text, so it cannot be selected or copied. A glyph in a <span> was part of the
// document: dragging across the header, or triple-clicking it, picked up "◎ prove it!" and put the
// logo on the clipboard as a character anyone could paste. aria-hidden because the Wordmark beside it
// already says the name — a screen reader announcing "bullseye prove it!" was never useful.
//
// select-none alone was not enough, which a browser probe showed rather than reasoning: it stops
// TEXT SELECTION and nothing else. The span and the svg both still computed `-webkit-user-drag: auto`
// and a dragstart fired unprevented, so the mark could be dragged straight out of the page as an
// image even with nothing selectable in it. Hence all three of:
//
//   • [-webkit-user-drag:none] — the property that actually governs dragging an element out (Chrome,
//     Safari). There is no standard equivalent; Firefox reads the draggable attribute instead.
//   • draggable={false} — the attribute half of the same thing, for Firefox.
//   • pointer-events-none on the svg — so the hit target is the plate, not the drawing. A right-click
//     that lands on an <svg> is what offers "Copy image" in the first place. Clicks still work: they
//     pass through to the span and to whatever wraps it (the top bar's logo is a button).
export function LogoBadge({ className }) {
  return (
    <span
      className={cx(
        "inline-grid shrink-0 place-items-center rounded-lg bg-[linear-gradient(140deg,#f5a623,#e0801a)] leading-none",
        "h-[30px] w-[30px] text-base select-none [-webkit-user-drag:none]",
        className,
      )}
      aria-hidden="true"
      draggable={false}
    >
      <svg
        viewBox="0 0 100 100"
        className="pointer-events-none h-[62%] w-[62%] overflow-visible select-none [-webkit-user-drag:none]"
        focusable="false"
        aria-hidden="true"
        draggable={false}
      >
        {/* Same numbers as the favicon and the PNG icons: ring outer 31 / inner 23.5 drawn as a
            stroke on the midline, dot r 11.5. The plate is the parent span's background. */}
        <circle cx="50" cy="50" r="27.25" fill="none" stroke="#241500" strokeWidth="7.5" />
        <circle cx="50" cy="50" r="11.5" fill="#241500" />
      </svg>
    </span>
  );
}

// select-none for the same reason as the badge: this is a logo, not prose. Selecting the header on
// the way to selecting something else used to sweep the brand name into the selection. Text is only
// draggable once it is selected, so select-none covers the drag case here on its own.
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

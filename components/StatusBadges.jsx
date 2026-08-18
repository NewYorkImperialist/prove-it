"use client";
import { cx } from "@/lib/browser/cx";

// The floating connection dot (lobby only — in game the sidebar shows it instead).
export function ConnBadge({ text, ok }) {
  return (
    <div className="fixed bottom-2.5 left-3.5 z-30 text-[11px] text-muted">
      <span className={cx(ok ? "text-accent2" : "text-bad")}>●</span> {text}
    </div>
  );
}

// The same indicator, inside the in-game sidebar.
export function ConnLine({ text, ok }) {
  return (
    <div className="relative px-4 pt-2 text-[11px] text-muted">
      <span className={cx("absolute left-[5px]", ok ? "text-accent2" : "text-bad")}>●</span> {text}
    </div>
  );
}

// Live player count — social proof, shown on the home/lobby cards only.
export function OnlineBadge({ count }) {
  return (
    <div className="fixed right-3.5 bottom-3 z-20 flex items-center gap-[7px] rounded-[20px] border border-line bg-panel2 py-[5px] pr-[11px] pl-2.5 font-mono text-[11px] font-semibold tracking-[.3px] text-muted">
      <span className="h-[7px] w-[7px] rounded-full bg-accent shadow-[0_0_0_3px_var(--color-accdim)]" />
      {count} online
    </div>
  );
}

// Owner broadcast (e.g. a pre-deploy heads-up). Tap to dismiss; auto-hides after 45s.
export function AnnounceBanner({ text, onDismiss }) {
  return (
    <div
      onClick={onDismiss}
      className="fixed top-0 right-0 left-0 z-[9998] animate-slide-down cursor-pointer bg-[linear-gradient(90deg,#f5c542,#ff8c42)] px-4 py-2.5 text-center text-sm font-extrabold text-[#1a1200] shadow-[0_2px_12px_rgba(0,0,0,.4)]"
    >
      {text}   (tap to dismiss)
    </div>
  );
}

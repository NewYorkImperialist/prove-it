"use client";
import { cx } from "@/lib/browser/cx";

// The centered panel every lobby screen lives in. `leaving` plays the fly-away half of a
// view transition; the enter half runs on mount (see hooks/useCardRouter.js).
export default function Card({ children, className, leaving = false, ...rest }) {
  return (
    <div
      className={cx(
        "w-[min(94vw,460px)] max-h-[92vh] overflow-y-auto rounded-2xl border border-line bg-panel px-8 py-[34px] shadow-[0_24px_70px_rgba(0,0,0,.6)] short:px-5 short:py-4",
        leaving ? "animate-view-leave" : "animate-view-enter",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }) {
  return <h1 className={cx("m-0 mb-1 font-display text-2xl", className)}>{children}</h1>;
}

export function CardSub({ children, className }) {
  return <p className={cx("m-0 mb-5 text-sm text-muted", className)}>{children}</p>;
}

// Small uppercase heading above a settings group.
export function GroupTitle({ children, className }) {
  return <div className={cx("mt-[18px] mb-2 text-xs tracking-[1px] text-muted uppercase", className)}>{children}</div>;
}

export function ErrorLine({ children, className }) {
  return <div className={cx("mt-2.5 min-h-4 text-[13px] text-bad", className)}>{children}</div>;
}

export function StatusLine({ children, className }) {
  return <div className={cx("mt-1.5 text-center text-[13px] text-muted", className)}>{children}</div>;
}

// "or join a room" — a centered caption with a rule running out either side.
export function Divider({ children }) {
  return (
    <div className="mt-[22px] mb-4 flex items-center gap-3 text-[11px] tracking-[1.2px] text-muted uppercase">
      <span className="h-px flex-1 bg-line2" />
      {children}
      <span className="h-px flex-1 bg-line2" />
    </div>
  );
}

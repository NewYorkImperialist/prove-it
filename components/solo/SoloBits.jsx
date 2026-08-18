"use client";
import { cx } from "@/lib/browser/cx";

// Solo's own button skin: taller and blockier than the lobby's, because these are the only
// controls on the screen.
export function SoloButton({ variant = "solid", className, ...rest }) {
  return (
    <button
      type="button"
      className={cx(
        "mt-[18px] block w-full cursor-pointer rounded-xl p-[15px] text-base font-extrabold active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50",
        variant === "ghost" ? "border border-line2 bg-panel2 text-ink" : "border-none bg-accent text-markfg",
        className,
      )}
      {...rest}
    />
  );
}

export function SoloCard({ children, className }) {
  return (
    <section className={cx("w-[min(94vw,460px)] overflow-visible rounded-2xl border border-line bg-panel px-8 py-[34px] shadow-[0_24px_70px_rgba(0,0,0,.6)]", className)}>
      {children}
    </section>
  );
}

export function SoloTitle({ children }) {
  return <h1 className="m-0 mb-1.5 font-display text-[25px] tracking-[-.4px]">{children}</h1>;
}

export function SoloSub({ children, className }) {
  return <p className={cx("m-0 mb-4 text-sm text-muted", className)}>{children}</p>;
}

export function SoloErr({ children }) {
  return <div className="mt-2 min-h-4 text-[13px] text-bad">{children}</div>;
}

// The big amber number the sprint and result screens lead with.
export function BigNumber({ children }) {
  return <div className="my-1.5 text-[46px] font-extrabold text-accent tabular-nums">{children}</div>;
}

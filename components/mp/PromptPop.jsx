"use client";

// Big centre-screen category reveal at the start of a round. Taps pass straight through, and
// it fades itself out — the animation is the whole lifecycle.
export default function PromptPop({ prompt }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-150 grid place-items-center p-5">
      <div
        key={prompt.key}
        className="max-w-[92vw] animate-prompt-pop rounded-[18px] border border-line2 bg-[rgba(12,10,7,.86)] px-[34px] py-[26px] text-center shadow-[0_24px_80px_rgba(0,0,0,.6)]"
      >
        <div className="mb-2 font-mono text-[13px] tracking-[2px] text-accent uppercase">{prompt.label}</div>
        <div className="font-display text-[clamp(28px,7vw,56px)] leading-[1.1] font-bold tracking-[-1px] text-ink">{prompt.name}</div>
      </div>
    </div>
  );
}

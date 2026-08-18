"use client";

// Total on-screen life of the reveal, in ms. The `prompt-pop` keyframes in app/globals.css run for
// exactly this long, and useMultiplayer imports it for the unmount timer — change all three together.
export const PROMPT_MS = 2400;

// Centre-screen category reveal at the start of a round. Taps pass straight through, and
// it fades itself out — the animation is the whole lifecycle. Deliberately sized as an overlay
// caption rather than a full-screen card so the message feed stays readable underneath it.
export default function PromptPop({ prompt }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-150 grid place-items-center p-5">
      <div
        key={prompt.key}
        className="max-w-[min(86vw,420px)] animate-prompt-pop rounded-[14px] border border-line2 bg-[rgba(12,10,7,.86)] px-[18px] py-[14px] text-center shadow-[0_16px_48px_rgba(0,0,0,.55)]"
      >
        <div className="mb-1 font-mono text-[11px] tracking-[1.6px] text-accent uppercase">{prompt.label}</div>
        <div className="font-display text-[clamp(22px,5.2vw,34px)] leading-[1.15] font-bold tracking-[-0.5px] text-ink">{prompt.name}</div>
      </div>
    </div>
  );
}

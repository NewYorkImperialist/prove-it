"use client";

// Tapping the in-game logo asks before it costs you the match.
export default function ConfirmLeave({ isRace, onReturn, onForfeit }) {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[rgba(8,10,15,.7)] backdrop-blur-[3px]">
      <div className="w-[min(90vw,360px)] rounded-2xl border border-line bg-panel p-6 text-center shadow-[0_24px_70px_rgba(0,0,0,.6)]">
        <h2 className="m-0 mb-2 text-xl">Leave the game?</h2>
        <p className="m-0 mb-[18px] text-sm text-muted">
          {isRace
            ? "The race continues without you — you won't be able to rejoin this match."
            : "If you forfeit, your opponent wins this match."}
        </p>
        <div className="flex flex-col gap-2.5">
          <button type="button" onClick={onReturn} className="cursor-pointer rounded-[10px] border-none bg-accent2 p-[13px] text-[15px] font-extrabold text-onaccent2">
            Return to your game
          </button>
          <button type="button" onClick={onForfeit} className="cursor-pointer rounded-[10px] border-none bg-bad p-[13px] text-[15px] font-extrabold text-white">
            Forfeit
          </button>
        </div>
      </div>
    </div>
  );
}

"use client";
import { SoloButton, SoloCard, SoloSub, BigNumber } from "./SoloBits";

// Between rounds: what you scored, and (after a geography round) the answers you missed, laid
// out to study rather than hidden behind a click.
export default function BetweenSection({ solo }) {
  const b = solo.between;
  if (!b) return null;

  return (
    <SoloCard>
      <SoloSub>
        Round {b.round} of {b.of} done
      </SoloSub>
      <BigNumber>{b.count}</BigNumber>
      <SoloSub>
        {b.cat} · {b.wpm} wpm · running total {b.running}
      </SoloSub>

      {solo.missed.length ? (
        <div className="my-1 mb-4">
          <button
            type="button"
            onClick={() => solo.setMissedOpen(!solo.missedOpen)}
            className="min-h-10 cursor-pointer border-none bg-transparent px-2 py-1.5 text-[13px] font-bold text-muted underline hover:text-accent"
          >
            {solo.missedOpen ? "Hide" : "Show"} the {solo.missed.length} you missed {solo.missedOpen ? "▴" : "▾"}
          </button>
          {solo.missedOpen ? (
            <div className="mt-2.5 flex max-h-[min(42vh,340px)] flex-wrap justify-center gap-1.5 overflow-y-auto text-left">
              {solo.missed.map((m, i) => (
                <span key={i} className="rounded-[7px] border border-line2 px-[9px] py-1 text-[12.5px] text-muted">
                  {m.a ? (
                    <>
                      <b className="font-bold text-ink">{m.q}</b> · <span className="font-bold text-accent">{m.a}</span>
                    </>
                  ) : (
                    m.q
                  )}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <SoloButton onClick={solo.nextRound}>{b.last ? "See results & leaderboard →" : "Next round →"}</SoloButton>
    </SoloCard>
  );
}

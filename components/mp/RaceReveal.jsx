"use client";
import { useState } from "react";

// Challenge Race's round-end card: everyone's answers, as a full-width feed block rather than
// a chat bubble. While the review window is open (non-final reveals) each player's wrong or
// off-list guesses are listed with an Approve button any *other* player can press.
export default function RaceReveal({ reveal: r, myId, onApproveMiss }) {
  const [approved, setApproved] = useState(() => new Set());

  const winnerNames = r.roundWinnerIds
    .map((id) => (r.perPlayer.find((p) => p.id === id) || {}).name)
    .filter(Boolean)
    .join(", ");

  // A sudden-death round is only played FOR the players who were tied for the lead: everyone
  // races, but the server scores nobody else (race-engine.js finalizeRound). Saying so is what
  // stops the card reading "Alice won the round!" straight above "Cara — 5 correct".
  const tb = !!r.tiebreaker;
  const benched = (p) => tb && p.eligible === false;

  const title = !r.final
    ? "Reviewing answers…"
    : r.tie
      ? r.suddenDeathTriggered
        ? "Tied — sudden death! One more round to break it."
        : "Round tied — no one scores this one."
      : tb
        ? `${winnerNames} won the tiebreaker!`
        : `${winnerNames} won the round!`;

  // Whoever could actually win it first, then by score — a bigger score from a player who wasn't
  // in the tiebreaker isn't the top of this round.
  const rows = r.perPlayer.slice().sort((a, b) => Number(benched(a)) - Number(benched(b)) || b.score - a.score);

  return (
    <div className="max-w-full self-stretch rounded-[10px] border border-line2 bg-panel2 px-3.5 py-2.5 text-[13px]">
      <div className="mb-1 font-extrabold">{title}</div>
      <div className="mb-1.5 text-xs text-muted">
        {r.category.emoji} {r.category.name}
        {tb ? " · sudden death: only the players tied for the lead could win this round" : ""}
      </div>
      {rows.map((p) => (
        <div key={p.id} className={benched(p) ? "opacity-60" : undefined}>
          <div className="my-1">
            <b className="text-gold">{p.name}</b>
            {benched(p) ? <span className="text-muted"> (not in the tiebreaker)</span> : null} — {p.score} correct
            {p.got.length ? <span className="text-muted">: {p.got.join(", ")}</span> : null}
          </div>
          {!r.final && p.misses && p.misses.length ? (
            <div className="my-0.5 mb-2 ml-1 flex flex-wrap gap-1.5">
              {p.misses.map((m) => {
                const key = `${p.id}:${m.id}`;
                return (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1.5 rounded-[7px] border border-line2 bg-[rgba(255,255,255,.04)] py-[3px] pr-1.5 pl-[9px] text-xs text-muted"
                  >
                    {m.text}
                    {p.id !== myId ? (
                      <button
                        type="button"
                        disabled={approved.has(key)}
                        // Optimistic: the tick shows straight away so a 25-chip reveal stays
                        // responsive. But it has to come back off if the server says no —
                        // otherwise a refused approval (review window closed, someone else
                        // already ruled on it) sits there looking like it counted.
                        onClick={async () => {
                          setApproved((s) => new Set(s).add(key));
                          const ok = await onApproveMiss(p.id, m.id);
                          if (!ok) setApproved((s) => { const n = new Set(s); n.delete(key); return n; });
                        }}
                        // 21px tall, and a reveal can carry 25 of these packed into inline chips —
                        // min-h-8 plus the chip's own padding gives a thumb something to aim at.
                        className="min-h-8 shrink-0 cursor-pointer rounded-md border-none bg-accent2 px-2.5 py-1 text-[11px] font-bold text-onaccent2 disabled:cursor-default disabled:opacity-50"
                      >
                        Approve
                      </button>
                    ) : null}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

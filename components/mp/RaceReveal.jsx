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

  const title = !r.final
    ? "Reviewing answers…"
    : r.tie
      ? r.suddenDeathTriggered
        ? "Tied — sudden death! One more round to break it."
        : "Round tied — no one scores this one."
      : `${winnerNames} won the round!`;

  const rows = r.perPlayer.slice().sort((a, b) => b.score - a.score);

  return (
    <div className="max-w-full self-stretch rounded-[10px] border border-line2 bg-panel2 px-3.5 py-2.5 text-[13px]">
      <div className="mb-1 font-extrabold">{title}</div>
      <div className="mb-1.5 text-xs text-muted">
        {r.category.emoji} {r.category.name}
      </div>
      {rows.map((p) => (
        <div key={p.id}>
          <div className="my-1">
            <b className="text-gold">{p.name}</b> — {p.score} correct
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
                        onClick={() => {
                          setApproved((s) => new Set(s).add(key));
                          onApproveMiss(p.id, m.id);
                        }}
                        className="cursor-pointer rounded-md border-none bg-accent2 px-[9px] py-[3px] text-[11px] font-bold text-onaccent2 disabled:cursor-default disabled:opacity-50"
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

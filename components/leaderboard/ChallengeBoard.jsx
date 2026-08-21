"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/browser/api";
import { collapseResults, columnMax, scoresOf, wpmsOf, avgWpm } from "@/lib/leaderboard";
import { LbTable, LbRow, LbCell, LbName, LbTotal, LbNote } from "./table";

// One challenge's board: a score column per round, then totals — plus a typing-speed table
// when anyone's run recorded WPM. `reloadKey` bumps to force a refetch (the Refresh button).
export default function ChallengeBoard({ id, visitorId, reloadKey = 0 }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    getJSON(`/challenge/${id}/results?me=${encodeURIComponent(visitorId || "")}`).then((data) => {
      if (!live) return;
      if (!data || !data.ok) return setState({ error: true });
      setState({ rounds: data.rounds || [], players: collapseResults(data) });
    });
    return () => {
      live = false;
    };
  }, [id, reloadKey]);

  if (state.loading) return <LbNote>Loading leaderboard…</LbNote>;
  if (state.error) return <LbNote>Couldn&apos;t load the leaderboard.</LbNote>;

  const { rounds, players } = state;
  if (!players.length) return <LbNote>No one has played yet · be the first!</LbNote>;

  const colMax = columnMax(players, rounds.length, scoresOf);
  const wpmMax = columnMax(players, rounds.length, wpmsOf);
  const anyWpm = players.some((p) => wpmsOf(p).some((n) => n > 0));
  // Server-supplied: visitor ids are no longer published to clients, since the rename endpoint
  // was treating them as proof of ownership.
  const mineOf = (p) => !!p.mine;

  const roundHead = rounds.map((r, i) => ({ label: `R${i + 1}`, title: r }));
  // Who took each individual round — the bragging-rights line under the table.
  const roundWinners = rounds
    .map((r, i) => {
      const w = players.find((p) => (scoresOf(p)[i] || 0) === colMax[i] && colMax[i] > 0);
      return w ? { round: i + 1, name: w.name, score: colMax[i] } : null;
    })
    .filter(Boolean);

  return (
    <>
      <LbTable head={[{ label: "#" }, { label: "Player" }, ...roundHead, { label: "Total" }]}>
        {players.map((p, idx) => (
          <LbRow key={idx} mine={mineOf(p)}>
            <LbCell className="text-left">{idx + 1}</LbCell>
            <LbName name={p.name} crown={p.crown} mine={mineOf(p)} />
            {rounds.map((_, i) => {
              const v = scoresOf(p)[i] || 0;
              return (
                <LbCell key={i} highlight={v === colMax[i] && v > 0}>
                  {v}
                </LbCell>
              );
            })}
            <LbTotal>{p.total}</LbTotal>
          </LbRow>
        ))}
      </LbTable>

      <LbNote>
        <b>{players[0].name}</b> leads with {players[0].total} · {players.length} player{players.length > 1 ? "s" : ""}.
      </LbNote>
      <LbNote>
        Round winners:{" "}
        {roundWinners.length
          ? roundWinners.map((w, i) => (
              <span key={w.round}>
                {i ? " · " : ""}
                <b>R{w.round}</b> {w.name} ({w.score})
              </span>
            ))
          : "·"}
      </LbNote>

      {anyWpm ? (
        <>
          <LbNote className="mt-3.5 text-ink">
            <b>Typing speed (WPM)</b>
          </LbNote>
          <LbTable head={[{ label: "Player" }, ...roundHead, { label: "Avg" }]}>
            {players.map((p, idx) => (
              <LbRow key={idx} mine={mineOf(p)}>
                <LbName name={p.name} crown={p.crown} mine={mineOf(p)} />
                {rounds.map((_, i) => {
                  const v = wpmsOf(p)[i] || 0;
                  return (
                    <LbCell key={i} highlight={v === wpmMax[i] && v > 0}>
                      {v || "·"}
                    </LbCell>
                  );
                })}
                <LbTotal>{avgWpm(p)}</LbTotal>
              </LbRow>
            ))}
          </LbTable>
        </>
      ) : null}

      <LbNote className="mt-3 opacity-70">{rounds.map((r, i) => `R${i + 1} ${r}`).join(" · ")}</LbNote>
    </>
  );
}

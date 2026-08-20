"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/browser/api";
import { fmtTime } from "@/lib/format";
import { LbTable, LbRow, LbCell, LbName, LbTotal, LbNote } from "./table";

// All-time best per player on one category — stats.js's categoryLeaderboard
// selects mode='solo' OR mode='link', but a link run only counts if its challenge used the
// recommended-time setting (timer===0), so the timing is comparable to a direct solo play. A daily
// run never lands here. The note below has
// to say so: this board is shown to whoever just finished a shared link too, and promising them "the
// all-time board" for a run that can't appear on it is the kind of lie players notice.
// Any single category can have one (the modal's Geography tab picks between the mapped ones; a
// one-round solo run shows its own), and a tie at the top is broken by the fastest full clear.
export default function CategoryBoard({ name, visitorId, reloadKey }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    setState({ loading: true });
    getJSON("/category-leaderboard?name=" + encodeURIComponent(name)).then((d) => {
      if (!live) return;
      if (!d || !d.ok) return setState({ error: true });
      setState({ rows: d.results || [] });
    });
    return () => {
      live = false;
    };
    // reloadKey: a retried save has to be able to refetch this, the way ChallengeBoard already can.
  }, [name, reloadKey]);

  if (state.loading) return <LbNote>Loading {name} leaderboard…</LbNote>;
  if (state.error) return <LbNote>Couldn&apos;t load the leaderboard.</LbNote>;
  if (!state.rows.length) return <LbNote>No scores yet — be the first!</LbNote>;

  return (
    <>
      <LbTable head={[{ label: "#" }, { label: "Player" }, { label: "Best" }, { label: "Time" }]}>
        {state.rows.map((r, i) => {
          const mine = !!r.visitor_id && r.visitor_id === visitorId;
          return (
            <LbRow key={i} mine={mine}>
              <LbCell className="text-left">{i + 1}</LbCell>
              <LbName name={r.name} crown={r.crown} mine={mine} />
              <LbTotal>{r.score}</LbTotal>
              <LbCell>{fmtTime(r.time)}</LbCell>
            </LbRow>
          );
        })}
      </LbTable>
      <LbNote>
        All-time best on <b>{name}</b> · {state.rows.length} player{state.rows.length > 1 ? "s" : ""}. Solo runs count,
        plus shared-link plays that used the recommended time; the daily has its own board. Tie at the top?
        Fastest full clear wins.
      </LbNote>
    </>
  );
}

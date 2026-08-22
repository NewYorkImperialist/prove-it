"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/browser/api";
import { dayFromChallengeId } from "@/lib/format";
import { LbTable, LbRow, LbCell, LbName, LbTotal, LbNote } from "./table";

// Each player's best single-day daily score, across every day the daily has run.
export default function DailyAllTimeBoard({ visitorId }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    getJSON("/daily/alltime").then((d) => {
      if (!live) return;
      if (!d || !d.ok) return setState({ error: true });
      setState({ rows: d.results || [] });
    });
    return () => {
      live = false;
    };
  }, []);

  if (state.loading) return <LbNote>Loading…</LbNote>;
  if (state.error) return <LbNote>Couldn&apos;t load the all-time board.</LbNote>;
  if (!state.rows.length) return <LbNote>No daily scores yet — be the first!</LbNote>;

  return (
    <>
      <LbTable head={[{ label: "#" }, { label: "Player" }, { label: "Best day" }, { label: "Score" }]}>
        {state.rows.map((r, i) => {
          const mine = !!r.visitor_id && r.visitor_id === visitorId;
          return (
            <LbRow key={i} mine={mine}>
              <LbCell className="text-left">{i + 1}</LbCell>
              <LbName name={r.name} crown={r.crown} mine={mine} />
              <LbCell>{dayFromChallengeId(r.challenge_id)}</LbCell>
              <LbTotal>{r.score}</LbTotal>
            </LbRow>
          );
        })}
      </LbTable>
      <LbNote>Each player&apos;s best single-day daily score, across every day.</LbNote>
    </>
  );
}

"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/browser/api";
import { LbTable, LbRow, LbCell, LbName, LbTotal, LbNote } from "./table";

// One overall geography ranking. Points reward BOTH volume and speed, summed across every
// geography category, so the top spot can't be taken with a single fast fluke or a slow grind.
// Solo runs only, like the per-category boards: stats.js's geoGoat filters mode='solo', so daily
// and shared-link geography runs contribute nothing — the note below promises no more than that.
export default function GoatBoard({ visitorId }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let live = true;
    getJSON("/geo-goat").then((d) => {
      if (!live) return;
      if (!d || !d.ok) return setState({ error: true });
      setState({ rows: d.results || [] });
    });
    return () => {
      live = false;
    };
  }, []);

  if (state.loading) return <LbNote>Loading…</LbNote>;
  if (state.error) return <LbNote>Couldn&apos;t load the GOAT board.</LbNote>;
  if (!state.rows.length) return <LbNote>No geography runs yet — play some to crown the GOAT! 🐐</LbNote>;

  return (
    <>
      <LbTable head={[{ label: "#" }, { label: "Player" }, { label: "Cats", title: "Geography categories played" }, { label: "GOAT pts" }]}>
        {state.rows.map((r, i) => {
          const mine = !!r.visitor_id && r.visitor_id === visitorId;
          return (
            <LbRow key={i} mine={mine}>
              <LbCell className="text-left">{i === 0 ? "🐐" : i + 1}</LbCell>
              <LbName name={r.name} crown={r.crown} mine={mine} />
              <LbCell>{r.cats}</LbCell>
              <LbTotal>{r.goat}</LbTotal>
            </LbRow>
          );
        })}
      </LbTable>
      <LbNote>
        Points from your <b>solo</b> runs across every geography category (daily and shared-link plays don&apos;t count): each answer
        scores, ×a speed bonus (up to 2× fast, ½× slow) when you clear them all. Name more, across more, faster.
      </LbNote>
    </>
  );
}

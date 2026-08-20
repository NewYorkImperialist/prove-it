"use client";
import { useEffect, useState } from "react";
import { getJSON } from "@/lib/browser/api";
import { LbTable, LbRow, LbCell, LbName, LbTotal, LbNote } from "./table";

// One overall geography ranking. Points reward volume, summed across every geography category,
// with a speed bonus on top for a full clear well under the recommended time — a leisurely full
// clear is never penalized, so the top spot rewards playing a lot rather than playing fast.
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
        Points across <b>every</b> geography category: each answer scores 1, and a full clear gets up to a 2× bonus for finishing well under the recommended time — never a penalty for taking the whole time. Name more, across more, faster. Solo runs count, plus shared-link plays that used the recommended time; the daily has its own board.
      </LbNote>
    </>
  );
}

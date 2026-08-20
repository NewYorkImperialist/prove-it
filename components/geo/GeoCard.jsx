"use client";
import { useMemo, useRef, useState } from "react";
import Card, { CardTitle, CardSub, GroupTitle, ErrorLine } from "@/components/ui/Card";
import Button, { BackButton } from "@/components/ui/Button";
import TextInput, { FieldLabel } from "@/components/ui/Field";
import GoatBoard from "@/components/leaderboard/GoatBoard";
import { MODES, boardsFor, allBoards } from "@/lib/geo-boards";
import { fmtClock } from "@/lib/format";
import * as store from "@/lib/browser/storage";
import { cx } from "@/lib/browser/cx";

// Geography's own screen, reached from the home card rather than from a dropdown buried in the
// solo builder. Two steps: pick a mode, then pick a region. The board categories are still in
// solo's "Pick a category" list — that one is the exhaustive index, this is the front door, and a
// custom multi-round run still needs to be able to include a map.
export default function GeoCard({ leaving, solo, onBack, onPlay }) {
  const [mode, setMode] = useState(null);
  const [nameErr, setNameErr] = useState("");
  const nameRef = useRef(null);

  // startSolo() needs a name before it can create the run, and it reports a missing one through
  // createErr — which only renders on the solo builder. Asking here keeps the failure on the
  // screen the player is actually looking at.
  const play = (catName) => {
    if (!solo.byName.trim()) {
      nameRef.current?.focus();
      return setNameErr("Enter your name first.");
    }
    setNameErr("");
    onPlay(catName);
  };
  // Read once per mount: a run leaves this screen entirely, so it can't change underneath us.
  const progress = useMemo(() => store.getGeoProgress(), []);
  const boards = allBoards();
  const cleared = boards.filter((b) => {
    const p = progress[b.name];
    return p && p.best >= p.total;
  }).length;
  const played = boards.filter((b) => progress[b.name]).length;

  const current = mode ? MODES.find((m) => m.key === mode) : null;

  return (
    <Card leaving={leaving}>
      <BackButton onClick={() => (mode ? setMode(null) : onBack())} />
      <CardTitle>🌍 Geography</CardTitle>
      <CardSub>
        {cleared > 0
          ? `${cleared} of ${boards.length} boards cleared · ${played} played.`
          : `${boards.length} boards. Maps, flags, borders and capitals — every one on its own leaderboard.`}
      </CardSub>

      <FieldLabel htmlFor="geoName">Your name</FieldLabel>
      <TextInput
        ref={nameRef}
        id="geoName"
        type="text"
        maxLength={20}
        placeholder="e.g. Jayden"
        value={solo.byName}
        onChange={(e) => solo.setByName(e.target.value)}
        className="mb-1 text-base!"
      />
      <ErrorLine>{nameErr || solo.createErr}</ErrorLine>

      {!current ? (
        <div className="flex flex-col gap-2.5">
          {MODES.map((m) => {
            const list = boardsFor(m.key);
            const done = list.filter((b) => progress[b.name] && progress[b.name].best >= progress[b.name].total).length;
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => setMode(m.key)}
                className="flex cursor-pointer items-center gap-3 rounded-xl border border-line2 bg-panel2 p-3 text-left transition hover:-translate-y-px hover:border-accent"
              >
                <span className="shrink-0 text-2xl" aria-hidden="true">{m.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-extrabold text-ink">{m.label}</span>
                  <span className="block text-xs text-muted">{m.blurb}</span>
                </span>
                <span className="shrink-0 text-right font-mono text-[11px] text-muted">
                  {done ? `${done}/${list.length}` : `${list.length}`}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <GroupTitle className="mt-0!">
            {current.emoji} {current.label}
          </GroupTitle>
          <div className="flex flex-col gap-2">
            {boardsFor(current.key).map((b) => {
              const p = progress[b.name];
              const isClear = p && p.best >= p.total;
              return (
                <button
                  key={b.name}
                  type="button"
                  onClick={() => play(b.name)}
                  className={cx(
                    "flex cursor-pointer items-center gap-3 rounded-[11px] border bg-panel2 px-3 py-2.5 text-left transition hover:-translate-y-px hover:border-accent",
                    isClear ? "border-accent2" : "border-line2",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{b.region}</span>
                    <span className="block font-mono text-[11px] text-muted">
                      {b.answers} answers · {fmtClock(b.seconds)}
                      {p ? ` · best ${p.best}/${p.total}` : ""}
                    </span>
                  </span>
                  {isClear ? <span className="shrink-0 text-sm text-accent2" title="Cleared">✓</span> : null}
                </button>
              );
            })}
          </div>
        </>
      )}

      <GroupTitle>All-time geography</GroupTitle>
      <GoatBoard visitorId={solo.visitorId} />

      <Button variant="ghost" className="mt-4 w-full" onClick={onBack}>
        Back to menu
      </Button>
    </Card>
  );
}

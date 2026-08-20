"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Card, { CardTitle, CardSub, GroupTitle, ErrorLine } from "@/components/ui/Card";
import Button, { BackButton } from "@/components/ui/Button";
import TextInput, { FieldLabel } from "@/components/ui/Field";
import GoatBoard from "@/components/leaderboard/GoatBoard";
import { MODES, boardsFor, allBoards, findBoard } from "@/lib/geo-boards";
import { fmtClock } from "@/lib/format";
import * as store from "@/lib/browser/storage";
import { cx } from "@/lib/browser/cx";

// Geography's own screen, reached from the home card rather than from a dropdown buried in the
// solo builder. Two steps: pick a mode, then pick a region. The board categories are still in
// solo's "Pick a category" list — that one is the exhaustive index, this is the front door, and a
// custom multi-round run still needs to be able to include a map.
export default function GeoCard({ leaving, solo, initialBoard, onBack, onPlay }) {
  // A shared board link (/?geo=<board>) opens on that board's mode, so the player lands looking at
  // the board they were sent rather than at the mode list. It deliberately does NOT start the run:
  // these are timed, and starting a clock because someone followed a link would spend the attempt
  // before they were ready.
  const [mode, setMode] = useState(() => findBoard(initialBoard)?.mode || null);
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
  // Scroll back to the top when the step changes: at 844x390 the card is ~357px tall, so clicking
  // a mode from the bottom of the list left you halfway down the region list with its heading
  // already scrolled off.
  const topRef = useRef(null);
  useEffect(() => {
    topRef.current?.scrollIntoView({ block: "start" });
  }, [mode]);
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
    <Card leaving={leaving} className="short:px-5! short:py-4!">
      <BackButton onClick={() => (mode ? setMode(null) : onBack())} />
      <span ref={topRef} aria-hidden="true" />
      {/* short: a landscape phone is ~357px of card. The title, blurb, name field and error line
          together ate ~290px of it, leaving room for exactly one region row. */}
      <CardTitle className="short:mb-0! short:text-xl">🌍 Geography</CardTitle>
      {/* Compacted in landscape, not hidden: this line carries the progress count, and hiding it
          to win header space took the one piece of information the screen exists to show. */}
      <CardSub className="short:mb-1! short:text-xs">
        {cleared > 0
          ? `${cleared} of ${boards.length} boards cleared · ${played} played.`
          : `${boards.length} boards. Maps, flags, borders and capitals — every one on its own leaderboard.`}
      </CardSub>

      <FieldLabel htmlFor="geoName" className="short:hidden">Your name</FieldLabel>
      <TextInput
        ref={nameRef}
        id="geoName"
        type="text"
        maxLength={20}
        placeholder="e.g. Jayden"
        value={solo.byName}
        onChange={(e) => {
          solo.setByName(e.target.value);
          if (nameErr) setNameErr(""); // it stayed on screen after you'd typed a name
        }}
        className="mb-1 text-base!"
      />
      {/* min-h-4 on ErrorLine reserves a line even when empty; with nothing to say in landscape
          that's a row of region list given away. And GroupTitle's mt-0! below used to sit flush
          against this when it DID have something to say. */}
      {nameErr || solo.createErr ? <ErrorLine className="mb-1">{nameErr || solo.createErr}</ErrorLine> : null}

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
                {/* Always cleared/total. It used to show a bare total when nothing was cleared,
                    so the same slot meant two different things and a mode you'd played but not
                    finished looked identical to one you'd never opened. */}
                <span className="shrink-0 text-right font-mono text-[11px] text-muted">
                  {done}/{list.length}
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
                  // accent2 is the same amber as accent (globals.css — "amber-only now"), so a
                  // cleared border was pixel-identical to the hover border: cleared looked hovered
                  // and hovered looked cleared. The tinted FILL is what distinguishes it.
                  className={cx(
                    "flex cursor-pointer items-center gap-3 rounded-[11px] border px-3 py-2.5 text-left transition hover:-translate-y-px hover:border-accent",
                    isClear ? "border-accent bg-accdim" : "border-line2 bg-panel2",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{b.region}</span>
                    {/* truncate, not wrap: at 320 the ✓ column took enough width that this broke
                        onto a second line mid-value ("… · best" / "197/197"), leaving cleared rows
                        20px taller than the rest. */}
                    <span className="block truncate font-mono text-[11px] text-muted">
                      {b.answers} answers · {fmtClock(b.seconds)}
                      {p ? ` · best ${p.best}/${p.total}` : ""}
                    </span>
                  </span>
                  {isClear ? <span className="w-4 shrink-0 text-center text-sm text-accent" title="Cleared">✓</span> : null}
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

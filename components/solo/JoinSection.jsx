"use client";
import { useState } from "react";
import { BackButton } from "@/components/ui/Button";
import TextInput, { FieldLabel } from "@/components/ui/Field";
import { SoloButton, SoloCard, SoloErr } from "./SoloBits";
import ChallengeBoard from "@/components/leaderboard/ChallengeBoard";

// Landing on a ?id= link: what was set up, and what you're trying to beat. The same card also
// catches a reload of your OWN run (info.mine), which is not a challenge from a stranger.
export default function JoinSection({ solo, onBack }) {
  const [showBoard, setShowBoard] = useState(false);
  const info = solo.joinInfo;
  const rounds = info ? `${info.nRounds} ${info.nRounds === 1 ? "round" : "rounds"}` : "";
  // "recommended time ." had a stray space, and one round isn't "45s each".
  const clock = !info ? "" : info.timer === 0 ? "recommended time per round" : `${info.timer}s${info.nRounds > 1 ? " each" : ""}`;

  return (
    <SoloCard>
      <BackButton onClick={onBack} />
      <div className="mb-3.5 rounded-xl border border-accent bg-accdim px-4 py-3.5 text-[15px]">
        {!info ? (
          "Loading challenge…"
        ) : info.mine === "played" ? (
          <>
            <b className="text-accent">This is your challenge.</b> You&apos;ve played it — your score is on the board below. Play{" "}
            <b>{rounds}</b>
            {info.genre ? (
              <>
                {" "}of <b>{info.genre}</b>
              </>
            ) : null}{" "}
            again ({clock}), or send this link to a friend.
          </>
        ) : info.mine === "playing" ? (
          <>
            <b className="text-accent">This is your run.</b> Reloading the page ended it — a round against the clock can&apos;t be
            picked back up, and nothing was scored. Play <b>{rounds}</b>
            {info.genre ? (
              <>
                {" "}of <b>{info.genre}</b>
              </>
            ) : null}{" "}
            again ({clock}), or send this link to a friend.
          </>
        ) : (
          <>
            <b className="text-accent">{info.by}</b> challenged you to name as many as you can across <b>{rounds}</b>
            {info.genre ? (
              <>
                {" "}of <b>{info.genre}</b>
              </>
            ) : null}
            , {clock}. Try to beat them!
          </>
        )}
      </div>

      <ul className="m-0 mt-2.5 list-none p-0">
        {(info?.rounds || []).map((r, i) => (
          <li key={i} className="mb-1.5 flex justify-between gap-2 rounded-[9px] border border-line px-2.5 py-2 text-sm">
            <span>
              R{i + 1} · {r.name}
            </span>
            {r.nonSprint ? (
              <span className="self-center rounded-md border border-bad px-1.5 py-0.5 font-mono text-[10px] tracking-[.5px] whitespace-nowrap text-bad uppercase">
                non-sprint
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <FieldLabel htmlFor="joinName">Your name</FieldLabel>
      <TextInput id="joinName" type="text" maxLength={20} placeholder="e.g. Sam" value={solo.joinName} onChange={(e) => solo.setJoinName(e.target.value)} className="text-base!" />
      <SoloErr>{solo.joinErr}</SoloErr>

      <SoloButton onClick={() => solo.startJoin(solo.joinName)} disabled={!info || !!solo.busy}>
        {solo.busy === "joining" ? "Starting…" : info && info.mine ? "Play it again" : "Start the challenge"}
      </SoloButton>
      <SoloButton variant="ghost" onClick={() => setShowBoard(true)}>
        View leaderboard
      </SoloButton>
      {/* Already played it (a reload of your own finished run): the board is the point, so it's
          open from the start rather than behind another click. */}
      {showBoard || (info && info.mine === "played") ? (
        <div className="mt-4">
          <ChallengeBoard id={solo.challengeId} visitorId={solo.visitorId} />
        </div>
      ) : null}
    </SoloCard>
  );
}

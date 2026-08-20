"use client";
import { useState } from "react";
import { BackButton } from "@/components/ui/Button";
import TextInput, { FieldLabel } from "@/components/ui/Field";
import { SoloButton, SoloCard, SoloErr } from "./SoloBits";
import ChallengeBoard from "@/components/leaderboard/ChallengeBoard";
import { fmtClock } from "@/lib/format";

// Landing on a ?id= link: what was set up, and what you're trying to beat. The same card also
// catches a reload of your OWN run (info.mine), which is not a challenge from a stranger.
export default function JoinSection({ solo, onBack }) {
  const [showBoard, setShowBoard] = useState(false);
  const info = solo.joinInfo;
  // A mid-run reload keeps ?id= in the URL, so it lands HERE rather than on the create screen —
  // which is the only place the resume offer used to be rendered. The snapshot was sitting in
  // storage the whole time while this card told you the run couldn't be picked back up.
  const resume = solo.resumeInfo && solo.resumeInfo.challengeId === solo.challengeId ? solo.resumeInfo : null;
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
          resume ? (
            <>
              <b className="text-accent">This is your run.</b> You left it in progress — pick it up below, or start{" "}
              <b>{rounds}</b>
              {info.genre ? (
                <>
                  {" "}of <b>{info.genre}</b>
                </>
              ) : null}{" "}
              again ({clock}).
            </>
          ) : (
            <>
              <b className="text-accent">This is your run.</b> It&apos;s too late to pick this one back up, and nothing was
              scored. Play <b>{rounds}</b>
              {info.genre ? (
                <>
                  {" "}of <b>{info.genre}</b>
                </>
              ) : null}{" "}
              again ({clock}), or send this link to a friend.
            </>
          )
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

      {/* Same offer the create screen makes, on the screen a mid-run reload actually lands on. */}
      {resume ? (
        <div className="mb-1 rounded-xl border border-accent bg-accdim p-3">
          <p className="m-0 mb-2 text-[13px] text-ink">
            <b>{resume.def.rounds[resume.cur]}</b> — {Math.max(0, resume.namedIds.length)} named,{" "}
            {fmtClock(Math.max(0, Math.round((resume.deadline - Date.now()) / 1000)))} left.
          </p>
          <div className="flex gap-2">
            <SoloButton className="mt-0! w-auto! shrink-0 px-5" onClick={solo.resumeRun}>
              Resume
            </SoloButton>
            <SoloButton variant="ghost" className="mt-0! w-auto! shrink-0 px-5" onClick={solo.dismissResume}>
              Discard
            </SoloButton>
          </div>
        </div>
      ) : null}

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

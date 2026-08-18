"use client";
import { useState } from "react";
import { BackButton } from "@/components/ui/Button";
import TextInput, { FieldLabel } from "@/components/ui/Field";
import { SoloButton, SoloCard, SoloErr } from "./SoloBits";
import ChallengeBoard from "@/components/leaderboard/ChallengeBoard";

// Landing on a friend's ?id= link: what they set up, and what you're trying to beat.
export default function JoinSection({ solo, onBack }) {
  const [showBoard, setShowBoard] = useState(false);
  const info = solo.joinInfo;

  const start = () => {
    const n = solo.joinName.trim().slice(0, 20);
    if (!n) return solo.setJoinErr("Enter your name first.");
    solo.setJoinErr("");
    solo.startPlaying(n);
  };

  return (
    <SoloCard>
      <BackButton onClick={onBack} />
      <div className="mb-3.5 rounded-xl border border-accent bg-accdim px-4 py-3.5 text-[15px]">
        {!info ? (
          "Loading challenge…"
        ) : (
          <>
            <b className="text-accent">{info.by}</b> challenged you to name as many as you can across <b>{info.nRounds}</b> round
            {info.nRounds > 1 ? "s" : ""}
            {info.genre ? (
              <>
                {" "}of <b>{info.genre}</b>
              </>
            ) : null}
            , {info.timer === 0 ? "recommended time" : <b>{info.timer}s</b>} {info.timer === 0 ? "" : "each"}. Try to beat them!
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

      <SoloButton onClick={start} disabled={!info}>
        Start the challenge
      </SoloButton>
      <SoloButton variant="ghost" onClick={() => setShowBoard(true)}>
        View leaderboard
      </SoloButton>
      {showBoard ? (
        <div className="mt-4">
          <ChallengeBoard id={solo.challengeId} visitorId={solo.visitorId} />
        </div>
      ) : null}
    </SoloCard>
  );
}

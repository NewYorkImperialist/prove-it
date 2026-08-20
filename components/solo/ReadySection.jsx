"use client";
import { useState } from "react";
import { BackButton } from "@/components/ui/Button";
import { SoloButton, SoloCard, SoloTitle, SoloSub } from "./SoloBits";
import ChallengeBoard from "@/components/leaderboard/ChallengeBoard";
import { useCopied } from "@/hooks/useCopied";
import { dailyLinkUrl } from "@/lib/browser/daily";
import * as store from "@/lib/browser/storage";

// The beat before the clock starts: share the link, then go. The daily also lets you peek at
// today's standings first.
export default function ReadySection({ solo, onBack }) {
  const [board, setBoard] = useState(0); // 0 = hidden; bumping it refetches
  const [copied, copy] = useCopied();
  const daily = solo.isDaily ? solo.daily : null;
  const loading = solo.isDaily && !daily;
  const cats = solo.roundCats;

  const title = loading ? "Loading today's daily…" : solo.isDaily ? "Daily Challenge" : `Ready, ${solo.byName || "you"}?`;
  const nRounds = `${cats.length} ${cats.length === 1 ? "round" : "rounds"}`;
  // "1 played today." read like a score, not a headcount.
  const played = !daily ? "" : daily.players === 0 ? "Be the first to play it today." : daily.players === 1 ? "1 player so far today." : `${daily.players} players so far today.`;
  const sub = loading
    ? ""
    : solo.isDaily
      ? `${daily.date} · ${nRounds} · ${daily.timer}s each · same puzzle for everyone. ${played}`
      : cats.length === 1
        ? `${cats[0].name}. Name as many as you can before the clock runs out.`
        : `${nRounds}. Name as many as you can before the clock runs out.`;

  return (
    <SoloCard>
      <BackButton onClick={onBack} />
      <SoloTitle>{title}</SoloTitle>
      <SoloSub>{sub}</SoloSub>

      <SoloButton variant="ghost" onClick={() => copy(solo.isDaily ? dailyLinkUrl(solo.challengeId, store.getSoloName()) : solo.challengeUrl())}>
        {copied ? "Link copied!" : solo.isDaily ? "Copy today's daily link" : "Copy link to challenge a friend"}
      </SoloButton>
      <SoloButton disabled={loading || !cats.length} onClick={() => solo.runCountdown(() => solo.startRound(0))}>
        Start
      </SoloButton>

      {solo.isDaily && !loading ? (
        <SoloButton variant="ghost" onClick={() => setBoard((n) => n + 1)}>
          {board ? "Refresh leaderboard" : "View today's leaderboard"}
        </SoloButton>
      ) : null}
      {board ? <ChallengeBoard id={solo.challengeId} visitorId={solo.visitorId} reloadKey={board} /> : null}
    </SoloCard>
  );
}

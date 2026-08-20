"use client";
import { useState } from "react";
import { BackButton } from "@/components/ui/Button";
import { SoloButton, SoloCard, SoloTitle, SoloSub, SoloErr } from "./SoloBits";
import ChallengeBoard from "@/components/leaderboard/ChallengeBoard";
import { useShareOrCopy } from "@/hooks/useCopied";
import { dailyLinkParts } from "@/lib/browser/daily";
import SITE from "@/lib/site-config";
import * as store from "@/lib/browser/storage";

// The beat before the clock starts: share the link, then go. The daily also lets you peek at
// today's standings first.
export default function ReadySection({ solo, onBack }) {
  const [board, setBoard] = useState(0); // 0 = hidden; bumping it refetches
  const { done: sent, shared, failed: sendFailed, native, run: sendLink } = useShareOrCopy();
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

  // Nobody has played yet on this screen, so there is no score to brag about — the daily's
  // pre-run wording lives with the rest of the daily copy, and a custom challenge gets a plain
  // "here are the rounds, beat me" line. `copy` is the bare URL either way, which is what
  // "Copy link…" has always put on the clipboard.
  const linkParts = () =>
    solo.isDaily
      ? dailyLinkParts(solo.challengeId, store.getSoloName())
      : { title: SITE.siteName, text: `Same rounds, same clock. Think you can beat me on ${SITE.siteName}?`, url: solo.challengeUrl(), copy: solo.challengeUrl() };

  // The copy path keeps its exact labels; the share path says share, because a sheet is what
  // opens. "Link copied!" after a share sheet would be untrue — nothing was copied.
  const linkLabel = sent
    ? shared
      ? "Shared!"
      : "Link copied!"
    : native
      ? solo.isDaily
        ? "Share today's daily link"
        : "Share this challenge with a friend"
      : solo.isDaily
        ? "Copy today's daily link"
        : "Copy link to challenge a friend";

  return (
    <SoloCard>
      <BackButton onClick={onBack} />
      <SoloTitle>{title}</SoloTitle>
      <SoloSub>{sub}</SoloSub>

      <SoloButton variant="ghost" onClick={() => sendLink(linkParts())}>
        {linkLabel}
      </SoloButton>
      {/* Conditional, not a reserved line: this screen's whole job is the Start button, and an
          always-present empty error row above it costs height on a landscape phone for nothing.
          Nothing on this screen writes the link out, so the message has to point at the screen
          that does — the results screen keeps it in a read-only box you can select by hand. */}
      {sendFailed ? <SoloErr>Couldn&apos;t copy — your browser blocked the clipboard. The results screen shows the link to copy by hand.</SoloErr> : null}
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

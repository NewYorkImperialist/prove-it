"use client";
import { useState } from "react";
import TextInput, { FieldLabel } from "@/components/ui/Field";
import { SoloButton, SoloCard, SoloSub, SoloErr, BigNumber } from "./SoloBits";
import ChallengeBoard from "@/components/leaderboard/ChallengeBoard";
import CategoryBoard from "@/components/leaderboard/CategoryBoard";
import { useCopied } from "@/hooks/useCopied";
import { useReplay } from "@/hooks/useReplay";
import { dailyInvite } from "@/lib/browser/daily";
import * as store from "@/lib/browser/storage";
import { cx } from "@/lib/browser/cx";

// The result screen, and the shareable link that turns it into a challenge. The daily adds an
// opt-in name entry for the public board plus your streak.
export default function DoneSection({ solo, onExitToMenu }) {
  const d = solo.done;
  const [name, setName] = useState(() => store.getSoloName());
  const [nameErr, setNameErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const [copied, copy] = useCopied(2200);
  const [shakeTick, setShakeTick] = useState(0);
  const [shaking, endShake] = useReplay(shakeTick);

  if (!d) return null;
  const url = solo.challengeUrl();

  const addMe = async () => {
    setNameErr("");
    if (!name.trim()) return;
    setSaving(true);
    const res = await solo.submitDaily(name);
    setSaving(false);
    if (res.blocked) {
      setShakeTick((n) => n + 1);
      return setNameErr("That name isn't allowed — try a different one.");
    }
    if (res.ok) {
      setSaved(true);
      setReload((r) => r + 1);
    }
  };

  return (
    <SoloCard>
      <p className="m-0 mb-3 text-[17px] font-bold text-accent">{d.verdict}</p>
      <BigNumber>{d.total}</BigNumber>
      <SoloSub>{d.sub}</SoloSub>

      {d.daily ? (
        <div>
          <FieldLabel htmlFor="dailyName">Put your name on today&apos;s leaderboard</FieldLabel>
          <div className="flex items-stretch gap-2.5">
            <TextInput
              id="dailyName"
              type="text"
              maxLength={20}
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onAnimationEnd={endShake}
              className={cx("min-w-0 flex-1 text-base!", shaking && "animate-shake border-bad!")}
            />
            <SoloButton className="mt-0! w-auto! shrink-0 px-5" disabled={saving} onClick={addMe}>
              {saving ? "Saving…" : saved ? "Update" : "Add me"}
            </SoloButton>
          </div>
          <SoloErr>{nameErr}</SoloErr>
          <SoloSub className="mt-2 mb-0">
            {d.streak > 1 ? `Current streak: ${d.streak} days. Come back tomorrow to keep it.` : "Play again tomorrow to start a streak."}
          </SoloSub>
        </div>
      ) : null}

      <div className="mt-3">
        {d.board.kind === "category" ? (
          <CategoryBoard name={d.board.name} visitorId={solo.visitorId} />
        ) : (
          <ChallengeBoard id={d.board.id} visitorId={solo.visitorId} reloadKey={reload} />
        )}
      </div>

      <FieldLabel>Share this link · friends play the same questions &amp; join this leaderboard</FieldLabel>
      <TextInput readOnly value={url} onClick={(e) => e.currentTarget.select()} className="font-mono text-[13px]!" />
      <SoloButton onClick={() => copy(d.daily ? dailyInvite(store.getDailyScore(), solo.challengeId, name) : url)}>
        {copied ? (d.daily ? "Copied — send it to a friend!" : "Copied! Paste it to a friend") : d.daily ? "Copy invite + my score" : "Copy challenge link"}
      </SoloButton>

      <div className="flex flex-wrap gap-2.5">
        <SoloButton variant="ghost" className="mt-3!" onClick={() => setReload((r) => r + 1)}>
          Refresh leaderboard
        </SoloButton>
        {d.geoChallenge ? (
          <>
            <SoloButton variant="ghost" className="mt-3!" onClick={solo.startGeoChallenge}>
              Play a different geography?
            </SoloButton>
            <SoloButton variant="ghost" className="mt-3!" onClick={() => solo.backToStart()}>
              Back to menu
            </SoloButton>
          </>
        ) : (
          <SoloButton variant="ghost" className="mt-3!" onClick={() => (d.daily ? onExitToMenu() : solo.backToStart())}>
            {d.daily ? "Back to menu" : "New challenge"}
          </SoloButton>
        )}
      </div>
    </SoloCard>
  );
}

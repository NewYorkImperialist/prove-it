"use client";
import { useRef, useState } from "react";
import TextInput, { FieldLabel, Select } from "@/components/ui/Field";
import { LogoBadge } from "@/components/ui/Logo";
import { SoloButton, SoloCard, SoloSub, SoloErr, BigNumber } from "./SoloBits";
import ChallengeBoard from "@/components/leaderboard/ChallengeBoard";
import CategoryBoard from "@/components/leaderboard/CategoryBoard";
import { useCopied } from "@/hooks/useCopied";
import { useReplay } from "@/hooks/useReplay";
import { dailyInvite } from "@/lib/browser/daily";
import { geoChallengeCats } from "@/lib/solo-catalog";
import * as store from "@/lib/browser/storage";
import { cx } from "@/lib/browser/cx";

// The result screen, and the shareable link that turns it into a challenge. Every run gets a
// chance to (re)name its leaderboard entry here — the daily also shows the streak.
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
  const [nextGeoCat, setNextGeoCat] = useState(() => geoChallengeCats()[0] || "");
  const nameRef = useRef(null);

  if (!d) return null;
  const url = solo.challengeUrl();

  const addMe = async () => {
    setNameErr("");
    // A bare `return` here meant tapping "Add me" with an empty box did nothing whatsoever: no
    // error, no shake, not even focus into the field you were supposed to fill in.
    if (!name.trim()) {
      setShakeTick((n) => n + 1);
      nameRef.current?.focus();
      return setNameErr("Enter a name to put on the board.");
    }
    setSaving(true);
    const res = await (d.daily ? solo.submitDaily(name) : solo.renameRun(name));
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
    <>
      {/* Same brand mark as the multiplayer top bar, doing the same job: one click all the way
          back to the homepage, from the one screen in solo that has no header of its own. */}
      <button
        type="button"
        onClick={onExitToMenu}
        title="Home"
        className="fixed top-3 left-3 z-[60] flex cursor-pointer items-center justify-center rounded-full border border-line bg-panel2 p-1.5 shadow-[0_8px_24px_rgba(0,0,0,.35)] transition hover:border-accent"
      >
        <LogoBadge className="h-[26px]! w-[26px]! text-sm!" />
      </button>

      <SoloCard>
        <p className="m-0 mb-3 text-[17px] font-bold text-accent">{d.verdict}</p>
        <BigNumber>{d.total}</BigNumber>
        <SoloSub>{d.sub}</SoloSub>

        {!d.daily && solo.saveErr ? (
          <div className="mb-3 rounded-xl border border-bad bg-[rgba(229,72,77,.1)] p-3">
            <p className="m-0 mb-2 text-[13px] text-bad">{solo.saveErr}</p>
            <SoloButton variant="ghost" className="mt-0!" onClick={solo.retryPendingResult}>
              Retry saving
            </SoloButton>
          </div>
        ) : null}

        <div>
          <FieldLabel htmlFor="boardName">{d.daily ? "Put your name on today's leaderboard" : "Your name on this leaderboard"}</FieldLabel>
          <div className="flex items-stretch gap-2.5">
            <TextInput
              ref={nameRef}
              id="boardName"
              type="text"
              maxLength={20}
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onAnimationEnd={endShake}
              className={cx("min-w-0 flex-1 text-base!", shaking && "animate-shake border-bad!")}
            />
            <SoloButton className="mt-0! w-auto! shrink-0 px-5" disabled={saving} onClick={addMe}>
              {saving ? "Saving…" : d.daily && !saved ? "Add me" : "Update"}
            </SoloButton>
          </div>
          <SoloErr>{nameErr}</SoloErr>
          {d.daily ? (
            <SoloSub className="mt-2 mb-0">
              {d.streak > 1 ? `Current streak: ${d.streak} days. Come back tomorrow to keep it.` : "Day 1 of your streak. Come back tomorrow to make it 2."}
            </SoloSub>
          ) : null}
        </div>

        <div className="mt-3">
          {d.board.kind === "category" ? (
            <CategoryBoard name={d.board.name} visitorId={solo.visitorId} reloadKey={reload} />
          ) : (
            <ChallengeBoard id={d.board.id} visitorId={solo.visitorId} reloadKey={reload} />
          )}
        </div>

        <FieldLabel>Share this link · friends play the same questions &amp; join this leaderboard</FieldLabel>
        <TextInput readOnly value={url} onClick={(e) => e.currentTarget.select()} className="font-mono text-[13px]!" />
        <SoloButton onClick={() => copy(d.daily ? dailyInvite(store.getDailyScore(), solo.challengeId, name) : url)}>
          {copied ? (d.daily ? "Copied — send it to a friend!" : "Copied! Paste it to a friend") : d.daily ? "Copy invite + my score" : "Copy challenge link"}
        </SoloButton>

        {d.geoChallenge ? (
          <div>
            <FieldLabel htmlFor="nextGeoCat">Or play a specific question next</FieldLabel>
            <div className="flex items-stretch gap-2.5">
              <Select id="nextGeoCat" value={nextGeoCat} onChange={(e) => setNextGeoCat(e.target.value)} className="min-w-0 flex-1">
                {geoChallengeCats().map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </Select>
              <SoloButton
                variant="ghost"
                className="mt-0! w-auto! shrink-0 px-6"
                onClick={() => nextGeoCat && solo.startGeoChallenge(nextGeoCat)}
              >
                Play
              </SoloButton>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2.5">
          <SoloButton variant="ghost" className="mt-3!" onClick={() => setReload((r) => r + 1)}>
            Refresh leaderboard
          </SoloButton>
          <SoloButton variant="ghost" className="mt-3!" onClick={() => (d.daily ? onExitToMenu() : solo.backToStart())}>
            {d.daily ? "Back to menu" : "New challenge"}
          </SoloButton>
        </div>
      </SoloCard>
    </>
  );
}

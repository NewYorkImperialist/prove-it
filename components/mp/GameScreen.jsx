"use client";
import { useEffect, useRef } from "react";
import { useSocketCtx } from "@/components/SocketProvider";
import { duelView } from "@/lib/duel-view";
import { raceView, raceFormatLine, raceRoster, raceBoardMode } from "@/lib/race-view";
import { fmtTime } from "@/lib/format";
import { cx } from "@/lib/browser/cx";
import TopBar from "./TopBar";
import Sidebar from "./Sidebar";
import Feed from "./Feed";
import PendingPanel from "./PendingPanel";
import InputBar from "./InputBar";
import PromptPop from "./PromptPop";
import RaceGeoBoard from "./RaceGeoBoard";
import { AVATARS } from "./WaitingRoom";

const DUEL_COLORS = ["var(--color-accent)", "#8a9aa0"];

// Build the roster both the header and the sidebar render from, so they can never disagree.
function duelRoster(gs, myId) {
  const me = gs.players.find((p) => p.id === myId) || gs.players[0];
  // Compare against `me`, not myId: a spectator/ghost is nobody, so matching on myId would
  // hand back `me` a second time and the other player would never be rendered.
  const opp = gs.players.find((p) => p !== me) || null;
  const live = gs.phase !== "roundover" && gs.phase !== "matchover" && !gs.paused;
  return [me, opp].filter(Boolean).map((p, i) => ({
    id: p.id,
    name: p.name,
    crown: p.crown,
    suffix: "",
    color: DUEL_COLORS[i],
    points: gs.scores[p.id] ?? 0,
    turn: live && gs.turnId === p.id,
    wins: null,
    inactive: false,
  }));
}

function raceRosterRows(g, myId) {
  const live = g.phase === "live";
  return raceRoster(g, myId).map((p, i) => ({
    id: p.id,
    name: p.name,
    crown: !!p.crown, // carried on the race snapshot's liveScores, as the duel's players are
    // Clocks are personal, so mark who has already run out and is waiting on the rest.
    suffix: (p.id === myId ? " (you)" : "") + (!p.active ? " · left" : live && p.done ? " · done" : ""),
    color: AVATARS[i % AVATARS.length],
    points: p.active ? (p.score ?? 0) : "—",
    turn: live && p.active && !p.done, // highlight whoever is still racing
    wins: (g.roundWins.find((r) => r.id === p.id) || {}).wins || 0,
    inactive: !p.active,
  }));
}

// The full-screen match view: header, category banner, feed, judging panel, clock, action row
// and the input bar — with the scoreboard sidebar on desktop. Both modes share this shell.
export default function GameScreen({ mp, onLeaveIntent }) {
  const { conn } = useSocketCtx();
  const isRace = mp.mode === "race";
  const state = isRace ? mp.raceGs : mp.gs;
  const feedRef = useRef(null);
  const wasOpening = useRef(false);

  const ctx = { myId: mp.myId, isSpectator: mp.isSpectator, isGhost: mp.isGhost, iAmHost: mp.iAmHost };
  const view = state
    ? isRace
      ? raceView(state, { ...ctx, reviewOpen: mp.reviewOpen })
      : duelView(state, ctx)
    : { enable: false, placeholder: "…", statusText: "", actions: [], canSkip: false };

  // Unmissable cue for whoever's opening: a red glow on the box, and a shake the moment it
  // becomes their turn.
  const openingCue = !isRace && !!mp.gs && mp.gs.phase === "opening" && mp.gs.turnId === mp.myId && !mp.chatMode;
  const { shakeInput } = mp;
  useEffect(() => {
    if (openingCue && !wasOpening.current) shakeInput();
    wasOpening.current = openingCue;
  }, [openingCue, shakeInput]);

  // Keep the newest message in view as the feed grows, and again when the action row or the
  // clock reflows and shrinks it.
  const stick = () => {
    const f = feedRef.current;
    if (f) f.scrollTop = f.scrollHeight;
  };
  useEffect(stick, [mp.feed]);
  useEffect(() => {
    const f = feedRef.current;
    if (f && f.scrollHeight - f.scrollTop - f.clientHeight < 90) stick();
  }, [view.actions.length, mp.clock.left, mp.typingBy]);

  if (!state) return null;

  const roster = isRace ? raceRosterRows(state, mp.myId) : duelRoster(state, mp.myId);
  // Geography rounds in a race get solo's board. It only ever shows my own answers — the server
  // withholds everyone else's until every clock is spent — and it needs most of the screen, so
  // the feed shrinks to a strip while it's up.
  const boardMode = isRace ? raceBoardMode(state) : null;
  const watching = state.spectators ? `  ·  ${state.spectators} watching` : "";
  const category = state.category;
  const claimLine = isRace
    ? raceFormatLine(state)
    : state.claim
      ? `Standing claim: ${state.claim} (${(state.players.find((p) => p.id === state.holderId) || {}).name || "?"})`
      : "";

  return (
    <div
      className="fixed left-0 z-20 grid w-full grid-cols-1 grid-rows-[46px_1fr] bg-bg desk:grid-cols-[1fr_300px] desk:grid-rows-[56px_1fr]"
      style={{ top: "var(--app-top,0)", height: "var(--app-height,100dvh)" }}
    >
      <TopBar
        mp={mp}
        roster={roster}
        roomLabel={(mp.myRoom ? "Room " + mp.myRoom : "") + watching}
        canSkip={!!view.canSkip}
        skipLabel={view.skipLabel}
        onLeaveIntent={onLeaveIntent}
      />


      {/* `relative` anchors the floating clock below: without it the nearest positioned ancestor
          was the fixed grid above, so the clock's `top-2` measured from the top of the SCREEN and
          painted it on top of the top bar's names and scores. */}
      <div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div
          // pr-[70px] keeps the category name clear of the floating clock pill on a phone; on a
          // desktop the clock is in the column below, so the banner gets its padding back.
          className="mx-3 mt-[7px] rounded-[14px] border border-line px-[13px] py-2 pr-[70px] desk:mx-5 desk:mt-4 desk:px-[22px] desk:py-[18px] short:py-2 short:pr-[70px]"
          style={{ background: "radial-gradient(120% 140% at 0 0,var(--color-accdim),transparent 55%),var(--color-panel2)" }}
        >
          <div className="hidden font-mono text-[11px] tracking-[1.4px] text-muted uppercase desk:block">
            {category ? `${category.emoji} ${category.group}` : "Category"}
          </div>
          <div className="font-display text-sm leading-[1.25] font-bold tracking-[-.5px] desk:mt-[5px] desk:text-[27px] short:mt-0 short:text-sm">{category ? category.name : "·"}</div>
          <div className="mt-[3px] min-h-[18px] text-xs text-gold desk:mt-1.5 desk:text-sm short:mt-[3px] short:text-xs">{claimLine}</div>
        </div>

        {boardMode ? <RaceGeoBoard catName={state.category.name} mode={boardMode} round={state.round} mine={mp.raceMine.got} /> : null}

        <Feed feed={mp.feed} scrollRef={feedRef} myId={mp.myId} onApproveMiss={mp.approveMiss} compact={!!boardMode} />

        {!isRace && !view.frozen ? (
          <PendingPanel gs={state} myId={mp.myId} onJudge={mp.judge} onRejectAll={mp.rejectAll} onRevoke={mp.revokeGrant} />
        ) : null}

        {mp.clock.left != null ? (
          <div
            className={cx(
              // Floats in the banner's top-right on a phone (the banner reserves `pr` for it, so
              // it never lands on the category name) and drops into the column on a desktop. A
              // landscape phone is wide enough for `desk:` but only ~390px tall, so `short:`
              // sends it back to floating rather than spending a row on it.
              "absolute top-[9px] right-4 z-[5] rounded-[20px] border px-3 py-0.5 text-center text-sm font-bold tabular-nums",
              "desk:static desk:mx-5 desk:mb-2 desk:rounded-[10px] desk:px-3 desk:py-2 desk:text-base",
              "short:absolute short:top-[9px] short:right-4 short:mx-0 short:mb-0 short:rounded-[20px] short:py-0.5 short:text-sm",
              mp.clock.danger ? "border-[rgba(255,91,110,.4)] bg-[rgba(255,91,110,.1)] text-bad" : "border-line bg-accdim text-accent",
            )}
          >
            {/* fmtTime, not the raw seconds this used to print: a race clock at its ceiling read
                "120s". fmtClock would drop the unit below a minute, leaving a bare "45" in a pill
                sitting next to the scores. */}
            {fmtTime(mp.clock.left)}
          </div>
        ) : null}

        {view.actions.length ? (
          <div className="flex gap-1.5 px-3 pt-1.5 desk:gap-2 desk:px-5 desk:pt-2">
            {view.actions.map((a) => (
              <ActionButton key={a.label} action={a} onClick={() => mp.runAction(a.action)} />
            ))}
          </div>
        ) : null}

        <div className={cx("min-h-4 px-3 pt-1 text-center text-xs desk:px-5 desk:pt-1.5 desk:text-[13px]", mp.flash ? "text-bad" : "text-muted")}>
          {mp.flash || view.statusText}
        </div>

        <div className="min-h-[17px] px-5 pt-px pb-[3px] text-xs text-accent2 italic">
          {mp.typingBy ? (
            <>
              {mp.typingBy} is typing
              {[0, 1, 2].map((i) => (
                <span key={i} className="animate-typing" style={{ animationDelay: i * 0.2 + "s" }}>
                  .
                </span>
              ))}
            </>
          ) : null}
        </div>

        <InputBar mp={mp} view={{ ...view, openingCue }} />
      </div>

      <Sidebar roster={roster} conn={conn} crownParty={mp.fx.crownParty} />
      {mp.prompt ? <PromptPop prompt={mp.prompt} /> : null}
    </div>
  );
}

const TONES = {
  raise: "hover:border-gold hover:bg-gold hover:text-[#1a1a1a]",
  danger: "hover:border-bad hover:bg-bad",
  again: "border-accent2! bg-accent2! text-onaccent2!",
  "": "hover:border-accent hover:bg-accent",
};

function ActionButton({ action, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()} /* don't steal focus → the keyboard stays open */
      className={cx(
        "flex-1 cursor-pointer rounded-[10px] border border-line bg-panel2 p-[9px] text-[13px] font-bold text-ink transition duration-[120ms] hover:border-accent hover:bg-accent desk:p-[13px] desk:text-sm",
        TONES[action.tone] ?? TONES[""],
      )}
    >
      {action.label}
    </button>
  );
}

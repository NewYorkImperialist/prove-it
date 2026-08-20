"use client";
import { useEffect, useRef, useState } from "react";
import { LogoBadge, Wordmark } from "@/components/ui/Logo";
import Seg from "@/components/ui/Seg";
import { GroupTitle } from "@/components/ui/Card";
import { CategoryChecks, TIMERS, WINS, INCREMENTS, ADVANCE } from "./LobbySettings";
import { useReplay } from "@/hooks/useReplay";
import { cx } from "@/lib/browser/cx";

const PILL = "cursor-pointer rounded-lg border border-line bg-panel2 font-bold text-muted transition duration-[120ms] hover:border-accent hover:bg-accent hover:text-white";
// The dropdown hangs off a fixed, non-scrolling grid, so it has to bound its own height: at
// 320×568 the menu ran 155px past the bottom of the screen and in landscape 339px, putting "Win
// at" and "Next round" somewhere you could neither see nor reach. `max-h` + `overflow-y-auto`
// keeps every item reachable, and `overscroll-contain` stops a flick at the end of the list from
// scrolling the page behind it.
const MENU =
  "absolute top-[46px] right-2 z-[6] max-h-[calc(var(--app-height,100dvh)-58px)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-panel shadow-[0_16px_40px_rgba(0,0,0,.5)] desk:top-[52px] desk:right-4 desk:max-h-[calc(var(--app-height,100dvh)-68px)]";

// Close a dropdown on any click that isn't inside it or on its own trigger.
function useDismiss(open, close, refs) {
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (refs.some((r) => r.current && r.current.contains(e.target))) return;
      close();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open, close, refs]);
}

// The compact score line that shares the mobile header with the logo and the ⋯ menu (desktop
// gets the full sidebar instead).
function TopScore({ roster }) {
  return (
    // This is the ONLY scoreboard on a phone — the full roster (Sidebar) is desktop-only. It used
    // to be `overflow-hidden` with flex children free to shrink, so an 8-player race squeezed every
    // name to 0px and the strip read "0· 0 0 0 0 0" — scores with nobody attached to them, and no
    // way to scroll to the rest. Now it scrolls sideways and each entry keeps a legible floor.
    <span className="flex min-w-0 flex-1 items-center gap-[7px] overflow-x-auto overscroll-x-contain text-[13px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden desk:hidden">
      {roster.map((p, i) => (
        <span key={p.id} className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          {i ? <span className="text-muted">·</span> : null}
          <span className={cx("max-w-[90px] truncate font-bold", p.turn && "text-accent2")}>
            {p.name}
            {p.crown ? " 👑" : ""}
          </span>
          <span className="font-extrabold text-gold tabular-nums">{p.points}</span>
        </span>
      ))}
    </span>
  );
}

export default function TopBar({ mp, roster, roomLabel, canSkip, skipLabel, onLeaveIntent }) {
  const [catOpen, setCatOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [gName, setGName] = useState("");
  const catBtn = useRef(null);
  const catMenu = useRef(null);
  const menuBtn = useRef(null);
  const menu = useRef(null);
  const [logoParty, endLogoParty] = useReplay(mp.fx.logoParty);

  useDismiss(catOpen, () => setCatOpen(false), [catBtn, catMenu]);
  useDismiss(menuOpen, () => setMenuOpen(false), [menuBtn, menu]);

  const gs = mp.gs;
  const raceGs = mp.raceGs;
  const isRace = mp.mode === "race";
  // Whichever mode is live publishes its category groups on its own snapshot; the mid-match
  // "setGroups" event is mode-agnostic on the server, so both modes change them the same way.
  const groups = ((isRace ? raceGs : gs)?.groups) || [];

  // Keep the rename field in step with the server, but never while it has focus.
  const meName = roster.find((p) => p.id === mp.myId)?.name;
  useEffect(() => {
    if (meName && document.activeElement?.id !== "gName") setGName(meName);
  }, [meName]);

  const saveName = () => {
    const n = gName.trim();
    if (n) mp.setName(n);
  };

  return (
    <div className="relative col-span-full flex items-center gap-2 border-b border-line bg-panel2 pr-1.5 pl-[9px] desk:gap-[18px] desk:px-5">
      <span
        onClick={onLeaveIntent}
        title="Leave game"
        onAnimationEnd={endLogoParty}
        className={cx(
          "flex origin-left cursor-pointer items-center gap-[9px] font-display text-base font-bold tracking-[-.3px]",
          logoParty && "animate-logo-party",
        )}
      >
        <LogoBadge className="h-[25px]! w-[25px]! text-sm! desk:h-7! desk:w-7! desk:text-[15px]!" />
        <Wordmark className="hidden desk:inline" />
      </span>

      <TopScore roster={roster} />

      <span className="hidden rounded-lg bg-panel2 px-2.5 py-1 text-[13px] text-muted desk:inline">{roomLabel}</span>
      {mp.isSpectator ? (
        <span className="hidden rounded-lg bg-gold px-[9px] py-1 text-xs font-extrabold text-onaccent2 desk:inline">{mp.isGhost ? "Ghost" : "Spectating"}</span>
      ) : null}

      <span className="flex-1" />

      {/* Host-only mid-game category switch — both modes apply it from the next round. */}
      {mp.iAmHost ? (
        <button
          ref={catBtn}
          type="button"
          onClick={() => {
            setMenuOpen(false);
            setCatOpen((o) => !o);
          }}
          className={cx(PILL, "hidden px-3 py-1.5 text-[13px] desk:inline-block")}
        >
          Categories ▾
        </button>
      ) : null}

      <button
        ref={menuBtn}
        type="button"
        title="Menu"
        onClick={() => {
          setCatOpen(false);
          setMenuOpen((o) => !o);
        }}
        className={cx(PILL, "min-h-10 shrink-0 px-3 py-1.5 text-sm")}
      >
        ⋯
      </button>

      {catOpen ? (
        <div ref={catMenu} className={cx(MENU, "w-[232px] p-2.5")}>
          <div className="mx-1 mt-0.5 mb-2 text-[11px] tracking-[1px] text-muted uppercase">Categories (applies next round)</div>
          <CategoryChecks groups={groups} onChange={mp.setGroupsNow} className="max-h-[280px] grid-cols-1!" />
        </div>
      ) : null}

      {menuOpen ? (
        <div ref={menu} className={cx(MENU, "w-[250px] px-3.5 pt-1 pb-3.5")}>
          <GroupTitle className="mt-1">Game</GroupTitle>
          {canSkip ? (
            <MenuButton
              title="Vote to skip this category"
              onClick={() => {
                mp.voteSkip();
                setMenuOpen(false);
              }}
            >
              {skipLabel}
            </MenuButton>
          ) : null}
          <MenuButton title={mp.muted ? "Sound off" : "Sound on"} onClick={mp.toggleMuted}>
            {mp.muted ? "Muted" : "Sound"}
          </MenuButton>
          {mp.crown.hasKey ? (
            <MenuButton title="Toggle your crown" onClick={mp.toggleCrown} className={mp.crown.on ? "border-gold! bg-[rgba(255,211,77,.18)]! opacity-100" : "opacity-50"}>
              👑 Crown
            </MenuButton>
          ) : null}
          {/* The dedicated Categories pill is desktop-only, so the host reaches the same panel
              from here on a phone. */}
          {mp.iAmHost ? (
            <MenuButton
              title="Change the categories (applies next round)"
              onClick={() => {
                setMenuOpen(false);
                setCatOpen(true);
              }}
            >
              Categories…
            </MenuButton>
          ) : null}
          <MenuButton onClick={mp.leaveRoom} className="last:mb-0 hover:border-bad hover:bg-bad hover:text-white">
            Leave game
          </MenuButton>

          <GroupTitle>Your name</GroupTitle>
          <div className="flex gap-2">
            <input
              id="gName"
              maxLength={20}
              autoComplete="off"
              value={gName}
              onChange={(e) => setGName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className="min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-[13px] py-3 text-[15px] text-ink outline-none focus:border-accent"
            />
            <button type="button" onClick={saveName} className="cursor-pointer rounded-[10px] border-none bg-accent2 px-3.5 font-extrabold text-onaccent2">
              Save
            </button>
          </div>

          {/* Duel: everything is live-adjustable. */}
          {gs && mp.iAmHost ? (
            <>
              <GroupTitle>Timer</GroupTitle>
              <Seg options={TIMERS} value={gs.timer} onChange={(timer) => mp.setSettings({ timer })} />
              <GroupTitle>Increment</GroupTitle>
              <Seg options={INCREMENTS} value={gs.increment || 0} onChange={(increment) => mp.setSettings({ increment })} />
              <GroupTitle>Win at</GroupTitle>
              <Seg options={WINS} value={gs.target == null ? null : gs.target} onChange={(target) => mp.setSettings({ target })} />
              <GroupTitle>Next round</GroupTitle>
              <Seg options={ADVANCE} value={gs.autoAdvance !== false} onChange={(autoAdvance) => mp.setSettings({ autoAdvance })} />
            </>
          ) : null}

          {/* Race: the timer and increment stay adjustable mid-match; the match format and
              sudden-death are locked once the first round is dealt, so they aren't offered. */}
          {raceGs && isRace && mp.iAmHost ? (
            <>
              <GroupTitle>Timer per round</GroupTitle>
              <Seg options={TIMERS} value={raceGs.timer} onChange={(timer) => mp.setRaceSettings({ timer })} />
              <GroupTitle>Increment</GroupTitle>
              <Seg options={INCREMENTS} value={raceGs.increment || 0} onChange={(increment) => mp.setRaceSettings({ increment })} />
              <div className="mt-2.5 text-xs text-muted">Applies from the next round. Match format is locked for this match.</div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MenuButton({ children, className, ...rest }) {
  return (
    <button
      type="button"
      className={cx("mb-1.5 w-full cursor-pointer rounded-lg border border-line bg-panel2 px-2.5 py-1.5 text-sm font-bold text-muted transition duration-[120ms] hover:border-accent", className)}
      {...rest}
    >
      {children}
    </button>
  );
}

"use client";
import CATEGORY_GROUPS from "@/data/categories";
import Seg, { Stepper } from "@/components/ui/Seg";
import CheckTile from "@/components/ui/CheckTile";
import { GroupTitle } from "@/components/ui/Card";
import { cx } from "@/lib/browser/cx";

export const TIMERS = [15, 30, 45, 60].map((s) => ({ value: s, label: s + "s" }));
export const WINS = [
  { value: 3, label: "3" },
  { value: 5, label: "5" },
  { value: 10, label: "10" },
  { value: null, label: "∞" }, // endless
];
// Bonus seconds a correct answer adds to the clock. In a duel that's the shared round clock; in
// a race every player has their own, so it only ever extends the answerer's (see race-engine.js).
export const INCREMENTS = [
  { value: 0, label: "0" },
  { value: 2, label: "+2s" },
  { value: 5, label: "+5s" },
];
export const ADVANCE = [
  { value: true, label: "Auto" },
  { value: false, label: "Manual (press P)" },
];
export const FORMATS = [
  { value: 3, label: "Best of 3" },
  { value: 5, label: "Best of 5" },
  { value: null, label: "Endless" },
];

const GROUPS = Object.entries(CATEGORY_GROUPS).map(([key, g]) => ({ key, emoji: g.emoji }));

// The category grid. Never lets the selection reach zero — unchecking the last one is a no-op.
export function CategoryChecks({ groups, onChange, disabled, className }) {
  return (
    <div className={cx("grid max-h-40 grid-cols-2 gap-2 overflow-y-auto", className)}>
      {GROUPS.map((g) => (
        <CheckTile
          key={g.key}
          emoji={g.emoji}
          label={g.key}
          checked={groups.includes(g.key)}
          disabled={disabled}
          onChange={(on) => {
            const next = on ? [...groups, g.key] : groups.filter((k) => k !== g.key);
            if (next.length) onChange(next);
          }}
        />
      ))}
    </div>
  );
}

// Host-only panels dim and stop taking input for everyone else.
function Panel({ locked, children }) {
  return <div className={cx(locked && "pointer-events-none opacity-55")}>{children}</div>;
}

function LockNote({ show }) {
  return show ? <div className="mt-2.5 text-center text-xs text-muted">Only the host can change settings.</div> : null;
}

// ---------- the duel lobby ----------
export function DuelSettings({ settings, iAmHost, onChange }) {
  const s = settings || {};
  return (
    <>
      <Panel locked={!iAmHost}>
        <GroupTitle>Categories</GroupTitle>
        <CategoryChecks groups={s.groups || []} disabled={!iAmHost} onChange={(groups) => onChange({ groups })} />
        <GroupTitle>Timer</GroupTitle>
        <Seg options={TIMERS} value={s.timer} onChange={(timer) => onChange({ timer })} />
        <GroupTitle>Time increment per correct answer</GroupTitle>
        <Seg options={INCREMENTS} value={s.increment || 0} onChange={(increment) => onChange({ increment })} />
        <Stepper value={s.increment || 0} onChange={(increment) => onChange({ increment })} ariaLess="less increment" ariaMore="more increment" />
        <GroupTitle>Win at</GroupTitle>
        <Seg options={WINS} value={s.target == null ? null : s.target} onChange={(target) => onChange({ target })} />
        <GroupTitle>Next round</GroupTitle>
        <Seg options={ADVANCE} value={s.autoAdvance !== false} onChange={(autoAdvance) => onChange({ autoAdvance })} />
      </Panel>
      <LockNote show={!iAmHost} />
    </>
  );
}

// ---------- the Challenge Race lobby ----------
// Categories and the timer mirror the duel's; format and sudden-death are race-only, and all
// of it is posted with raceSetSettings rather than setSettings.
export function RaceSettings({ settings, iAmHost, onChange }) {
  const s = settings || {};
  return (
    <>
      <Panel locked={!iAmHost}>
        <GroupTitle>Categories</GroupTitle>
        <CategoryChecks groups={s.groups || []} disabled={!iAmHost} onChange={(groups) => onChange({ groups })} />
        <GroupTitle>Timer per round</GroupTitle>
        <Seg options={TIMERS} value={s.timer} onChange={(timer) => onChange({ timer })} />
        <GroupTitle>Time increment per correct answer</GroupTitle>
        <Seg options={INCREMENTS} value={s.increment || 0} onChange={(increment) => onChange({ increment })} />
        <Stepper value={s.increment || 0} onChange={(increment) => onChange({ increment })} ariaLess="less increment" ariaMore="more increment" />
        <div className="mt-2 text-xs text-muted">
          Each racer has their own clock: this only extends the clock of whoever answered. Everyone else waits for the round to finish.
        </div>
        <GroupTitle>Match format</GroupTitle>
        <Seg options={FORMATS} value={s.format == null ? null : s.format} onChange={(format) => onChange({ format })} />
        <CheckTile
          className="mt-2"
          label="Sudden death on ties"
          checked={!!s.suddenDeath}
          disabled={!iAmHost}
          onChange={(suddenDeath) => onChange({ suddenDeath })}
        />
      </Panel>
      <LockNote show={!iAmHost} />
    </>
  );
}

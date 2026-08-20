"use client";
import SITE from "@/site-config";
import Card from "@/components/ui/Card";
import Button, { NewTag } from "@/components/ui/Button";
import { LogoBadge, Wordmark } from "@/components/ui/Logo";
import LaurelButton from "./LaurelButton";
import { cx } from "@/lib/browser/cx";

const FULL = "mt-2.5 w-full p-[13px]";

export default function HomeCard({ leaving, dailyPlayed, onSolo, onDaily, onMultiplayer, onRace, onLeaderboards }) {
  return (
    <Card leaving={leaving}>
      <div className="mb-3 flex items-center gap-3">
        <h1 className="m-0 flex items-center gap-3">
          <LogoBadge className="h-[38px]! w-[38px]! text-[21px]!" />
          <Wordmark className="text-[26px]" />
        </h1>
        <LaurelButton onClick={onLeaderboards} />
      </div>
      <p className="m-0 mb-6 text-sm text-muted">Think you&apos;ve got what it takes to name it all in time? Prove it!</p>

      <Button variant="primary" className="mt-0!" onClick={onSolo}>
        Play Solo
      </Button>

      {/* Glowing amber while today is unplayed; quiet with a "come back tomorrow" tooltip once done. */}
      <Button
        variant="secondary"
        onClick={onDaily}
        title={dailyPlayed ? "You played! Check back tomorrow." : undefined}
        className={cx(
          FULL,
          dailyPlayed
            ? "relative after:pointer-events-none after:absolute after:bottom-[calc(100%+8px)] after:left-1/2 after:z-[5] after:-translate-x-1/2 after:rounded-lg after:border after:border-line2 after:bg-[#0c0d10] after:px-2.5 after:py-1.5 after:text-xs after:font-semibold after:whitespace-nowrap after:text-white after:opacity-0 after:transition-opacity after:duration-[140ms] after:content-['You_played!_Check_back_tomorrow.'] hover:after:opacity-100"
            : "animate-daily-glow border-accent! bg-accent! text-markfg!",
        )}
      >
        Daily Challenge
      </Button>

      <Button variant="secondary" className={FULL} onClick={onMultiplayer}>
        Live Multiplayer
      </Button>
      <Button variant="secondary" highlight className={FULL} onClick={onRace}>
        Challenge Race <NewTag />
      </Button>

      <p className="mt-4 mb-0 text-center text-xs text-muted">
        Created by{" "}
        <a href={SITE.credit.url} target="_blank" rel="noopener" className="inline-block py-2 font-semibold text-accent no-underline hover:underline">
          {SITE.credit.name}
        </a>
      </p>
    </Card>
  );
}

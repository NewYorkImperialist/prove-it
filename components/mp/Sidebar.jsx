"use client";
import SITE from "@/lib/site-config";
import { Crown } from "@/components/ui/Logo";
import { ConnLine } from "@/components/StatusBadges";
import { useReplay } from "@/hooks/useReplay";
import { cx } from "@/lib/browser/cx";

// Desktop-only scoreboard. On mobile these numbers live in the header instead.
export default function Sidebar({ roster, conn, crownParty }) {
  const [party, endParty] = useReplay(crownParty);

  return (
    <div className="hidden min-h-0 flex-col overflow-y-auto border-l border-line bg-panel desk:flex">
      <h2 className="m-0 px-4 pt-4 pb-2 text-xs tracking-[1px] text-muted uppercase">Players</h2>
      <div>
        {roster.map((p) => (
          <div
            key={p.id}
            className={cx(
              "flex items-center gap-2.5 border-b border-line px-4 py-2.5",
              p.turn && "bg-[rgba(91,140,255,.10)]",
              p.inactive && "text-muted italic",
            )}
          >
            <div className="grid h-[30px] w-[30px] place-items-center rounded-lg font-extrabold text-markfg" style={{ background: p.color }}>
              {p.name[0].toUpperCase()}
            </div>
            <div className="flex-1 text-sm font-semibold" onAnimationEnd={endParty}>
              {p.name}
              {p.suffix}
              {p.crown ? <Crown party={party} /> : null}
            </div>
            <div className="text-base font-extrabold text-gold tabular-nums">
              {p.points}
              {p.wins != null ? <span className="text-[11px] text-muted"> · {p.wins} win{p.wins === 1 ? "" : "s"}</span> : null}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-auto">
        <ConnLine text={conn.text} ok={conn.ok} />
        <div className="border-t border-line px-4 py-3.5 text-xs text-muted">
          Created by{" "}
          <a href={SITE.credit.url} target="_blank" rel="noopener" className="font-semibold text-accent no-underline hover:underline">
            {SITE.credit.name}
          </a>
        </div>
      </div>
    </div>
  );
}

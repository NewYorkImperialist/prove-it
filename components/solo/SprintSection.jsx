"use client";
import { useEffect, useRef, useState } from "react";
import { BackButton } from "@/components/ui/Button";
import { SoloButton } from "./SoloBits";
import FlagBoard from "./FlagBoard";
import { useReplay } from "@/hooks/useReplay";
import { cx } from "@/lib/browser/cx";

// The round itself: the clock, the count, the geography board or flag grid when there is one,
// and the box you type into. Geography and flags rounds go full-screen (see SoloApp's mapmode)
// so the board has room to breathe.
export default function SprintSection({ solo, onBack }) {
  const [value, setValue] = useState("");
  const inputRef = useRef(null);
  const [shaking, endShake] = useReplay(solo.shakeTick);
  const cat = solo.roundCats[solo.cur];
  const flagMode = !!(cat && cat.isFlagQuiz);
  const mapMode = !!solo.geoMode || flagMode;

  // Focus the box (and clear the last round's text) whenever a new round starts.
  useEffect(() => {
    setValue("");
    inputRef.current?.focus();
  }, [solo.cur]);

  const submit = () => {
    const q = value.trim();
    if (!q) return;
    if (!solo.submit(q)) setValue(""); // a near-miss keeps the text so they can re-spell it
  };

  if (!cat) return null;

  return (
    <section
      className={cx(
        "rounded-2xl border border-line bg-panel px-8 py-[34px] shadow-[0_24px_70px_rgba(0,0,0,.6)]",
        mapMode ? "mx-auto flex h-full w-full max-w-[1000px] flex-col rounded-none px-3.5 py-2.5 shadow-none" : "w-[min(94vw,460px)]",
      )}
    >
      <BackButton onClick={onBack}>← Back to lobby</BackButton>

      <div className="mb-3 flex gap-[5px]">
        {solo.roundCats.map((_, j) => (
          <span
            key={j}
            className={cx("h-[5px] flex-1 rounded-[3px]", j < solo.cur ? "bg-accent" : j === solo.cur ? "bg-accent opacity-50" : "bg-line2")}
          />
        ))}
      </div>

      <div className="mb-2.5 flex items-center justify-between">
        <div>
          <div className="font-mono text-[11px] tracking-[1.4px] text-muted uppercase">
            Round {solo.cur + 1} of {solo.roundCats.length} · {cat.emoji} {cat.group}
          </div>
          <div className="font-display text-[22px] font-bold tracking-[-.3px]">{cat.name}</div>
        </div>
        <div className={cx("text-[28px] font-extrabold tabular-nums", solo.timeLeft <= 10 ? "text-bad" : "text-accent")}>{solo.clock}</div>
      </div>

      <div className="flex items-baseline gap-3.5">
        <span className="text-[40px] font-extrabold text-ink tabular-nums">{solo.countLabel}</span>
        <span className="font-mono text-[11px] tracking-[1.4px] text-muted uppercase tabular-nums">{solo.wpm ? `${solo.wpm} wpm` : ""}</span>
      </div>

      <div className="my-2 flex gap-2">
        {solo.geoMode === "map" ? (
          <SoloButton variant="ghost" className={cx("mt-0! p-[9px]! text-[13px]!", solo.remOn && "border-accent! bg-accent! text-markfg!")} onClick={solo.toggleRemaining}>
            {solo.remOn ? "Hide what's left" : "Show what's left"}
          </SoloButton>
        ) : null}
        <SoloButton variant="ghost" className="mt-0! p-[9px]! text-[13px]!" onClick={solo.giveUp}>
          Give up
        </SoloButton>
      </div>

      {/* D3 owns this node (lib/browser/geomap.js), so React must not render children into it.
          A column: the map takes the free space and the island fill-in boxes sit underneath it. */}
      <div ref={solo.mapEl} className={cx("w-full", solo.geoMode ? "my-2 flex min-h-0 flex-1 flex-col" : "hidden")} />

      {flagMode ? (
        <FlagBoard
          entries={cat.entries}
          selected={solo.flagSel}
          namedIds={solo.namedIds}
          onSelect={(i) => {
            solo.selectFlag(i);
            setValue("");
            inputRef.current?.focus();
          }}
        />
      ) : null}

      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck="false"
        placeholder={flagMode ? "Type this flag's country…" : "Type a name and hit Enter…"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") return submit();
          if (!flagMode) return;
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            solo.moveFlagSel(1);
            setValue("");
          } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            solo.moveFlagSel(-1);
            setValue("");
          }
        }}
        onAnimationEnd={endShake}
        // Geography rounds: when the keyboard opens, pull the box down so the map stays in view.
        onFocus={() => {
          if (!mapMode) return;
          setTimeout(() => {
            try {
              inputRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
            } catch {
              /* older Safari: not worth a fallback */
            }
          }, 260);
        }}
        className={cx(
          "w-full rounded-[10px] border border-line2 bg-bg px-[13px] py-3 text-base text-ink outline-none focus:border-accent",
          shaking && "animate-cshake",
        )}
      />
      <div className="mt-2 min-h-[18px] text-[13px] text-muted">{solo.cmsg}</div>

      {solo.geoMode !== "fill" && !flagMode ? (
        <div className={cx("mt-3 flex flex-wrap gap-1.5 overflow-y-auto", mapMode ? "max-h-[11vh]" : "max-h-[24vh] desk:max-h-[30vh]")}>
          {solo.chips.map((c, i) => (
            <span key={`${c}-${i}`} className="animate-chip rounded-lg border border-line2 bg-accdim px-[9px] py-[5px] text-[13px] text-ink">
              {c}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

"use client";
import { useEffect, useState } from "react";
import { cx } from "@/lib/browser/cx";
import CreateSection from "./CreateSection";
import JoinSection from "./JoinSection";
import ReadySection from "./ReadySection";
import SprintSection from "./SprintSection";
import BetweenSection from "./BetweenSection";
import DoneSection from "./DoneSection";

// The solo overlay. It sits on the same background as the lobby, so only the card animates on
// the way in — the page never flashes. Moving between solo's own screens is an instant cut,
// the way it always was.
export default function SoloApp({ solo, onExitToMenu }) {
  const mapMode = solo.screen === "sprint" && !!solo.geoMode;
  const [entering, setEntering] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setEntering(false), 320);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="fixed right-0 left-0 z-50 flex flex-col bg-bg text-ink"
      style={{ top: "var(--app-top,0)", height: "var(--app-height,100dvh)" }}
    >
      <main
        className={cx(
          "flex min-h-0 flex-1 flex-col overflow-y-auto",
          mapMode
            ? "items-stretch justify-start overflow-hidden px-2.5 py-2"
            : "items-center justify-start px-3.5 py-4 desk:justify-safe-center desk:px-4 desk:py-[22px]",
        )}
      >
        <div
          className={cx(
            "flex w-full flex-col items-center",
            mapMode && "min-h-0 flex-1",
            entering && "animate-view-enter",
          )}
        >
          {solo.screen === "create" ? <CreateSection solo={solo} onBack={onExitToMenu} /> : null}
          {solo.screen === "join" ? <JoinSection solo={solo} onBack={onExitToMenu} /> : null}
          {solo.screen === "ready" ? (
            <ReadySection solo={solo} onBack={() => (solo.isDaily ? onExitToMenu() : solo.backToStart())} />
          ) : null}
          {solo.screen === "sprint" ? <SprintSection solo={solo} onBack={solo.leaveRun} /> : null}
          {solo.screen === "between" ? <BetweenSection solo={solo} /> : null}
          {solo.screen === "done" ? <DoneSection solo={solo} onExitToMenu={onExitToMenu} /> : null}
        </div>
      </main>

      {solo.countdown ? (
        <div className="fixed inset-0 z-200 grid place-items-center bg-[rgba(12,10,7,.72)]">
          <span
            key={solo.countdown.key}
            className={cx(
              "animate-countdown font-display leading-none font-bold text-accent",
              solo.countdown.text === "GO!" ? "text-[130px]" : "text-[170px]",
            )}
          >
            {solo.countdown.text}
          </span>
        </div>
      ) : null}
    </div>
  );
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSocketCtx } from "@/components/SocketProvider";
import { useCardRouter } from "@/hooks/useCardRouter";
import { useMultiplayer } from "@/hooks/useMultiplayer";
import { useSolo } from "@/hooks/useSolo";
import { useAppHeight } from "@/hooks/useAppHeight";
import { playedDailyToday } from "@/lib/browser/daily";
import { ConnBadge, OnlineBadge, AnnounceBanner } from "@/components/StatusBadges";
import HomeCard from "@/components/home/HomeCard";
import MpSetupCard from "@/components/mp/MpSetupCard";
import RaceSetupCard from "@/components/mp/RaceSetupCard";
import WaitingRoom from "@/components/mp/WaitingRoom";
import GameScreen from "@/components/mp/GameScreen";
import ConfirmLeave from "@/components/mp/ConfirmLeave";
import LeaderboardModal from "@/components/leaderboard/LeaderboardModal";
import SoloApp from "@/components/solo/SoloApp";
import Confetti from "@/components/fx/Confetti";
import OilRain from "@/components/fx/OilRain";

// The whole client, in one place: the lobby cards, the match screen, the solo overlay and the
// leaderboard modal, plus the badges that float above all of them.
export default function AppShell() {
  const { conn, online, announce, dismissAnnounce } = useSocketCtx();
  const router = useCardRouter("home");
  const mp = useMultiplayer({ router });
  const [lbOpen, setLbOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [dailyPlayed, setDailyPlayed] = useState(false);

  const backToMenu = useCallback(() => router.leaveTo("home"), [router]);
  const solo = useSolo({ onExitToMenu: backToMenu });

  useAppHeight();

  // The Daily button glows while today is unplayed and goes quiet once it's done.
  useEffect(() => {
    setDailyPlayed(playedDailyToday());
  }, [solo.done, lbOpen]);

  // A shared ?id= challenge link opens straight into the solo join screen.
  const deepLink = useRef(null);
  if (deepLink.current === null) {
    deepLink.current = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("id") || "";
  }
  const bootedDeepLink = useRef(false);
  useEffect(() => {
    if (bootedDeepLink.current || !deepLink.current) return;
    bootedDeepLink.current = true;
    solo.initJoin(deepLink.current);
    router.go("solo");
  }, [solo, router]);

  const openSolo = () => {
    solo.initCreate();
    router.leaveTo("solo");
  };
  const openDaily = () => {
    if (playedDailyToday()) return setLbOpen(true); // played → leaderboard only, no replay
    solo.initDaily();
    router.leaveTo("solo");
  };

  const inGame = router.view === "game";
  const inSolo = router.view === "solo";

  return (
    <>
      {announce ? <AnnounceBanner text={announce} onDismiss={dismissAnnounce} /> : null}
      {/* In a match the sidebar shows the connection instead; solo covers the lobby entirely. */}
      {!inGame && !inSolo ? <ConnBadge text={conn.text} ok={conn.ok} /> : null}
      {!inGame && !inSolo && online > 0 ? <OnlineBadge count={online} /> : null}

      {router.view === "home" ? (
        <HomeCard
          leaving={router.leaving}
          dailyPlayed={dailyPlayed}
          onSolo={openSolo}
          onDaily={openDaily}
          onMultiplayer={() => {
            mp.setErr("home", "");
            router.leaveTo("mpsetup");
          }}
          onRace={() => {
            mp.setErr("race", "");
            router.leaveTo("racesetup");
          }}
          onLeaderboards={() => setLbOpen(true)}
        />
      ) : null}

      {router.view === "mpsetup" ? <MpSetupCard leaving={router.leaving} mp={mp} onBack={backToMenu} /> : null}
      {router.view === "racesetup" ? (
        <RaceSetupCard
          leaving={router.leaving}
          mp={mp}
          onBack={() => {
            mp.leaveQuickMatch();
            backToMenu();
          }}
        />
      ) : null}
      {router.view === "room" ? <WaitingRoom leaving={router.leaving} mp={mp} /> : null}
      {inGame ? <GameScreen mp={mp} onLeaveIntent={() => setConfirmLeave(true)} /> : null}
      {inSolo ? <SoloApp solo={solo} onExitToMenu={backToMenu} /> : null}

      {confirmLeave ? (
        <ConfirmLeave
          isRace={mp.mode === "race"}
          onReturn={() => setConfirmLeave(false)}
          onForfeit={() => {
            setConfirmLeave(false);
            mp.leaveRoom();
          }}
        />
      ) : null}

      {lbOpen ? <LeaderboardModal onClose={() => setLbOpen(false)} visitorId={solo.visitorId} /> : null}

      <Confetti trigger={mp.fx.confetti} />
      <OilRain trigger={mp.fx.oil} />
    </>
  );
}

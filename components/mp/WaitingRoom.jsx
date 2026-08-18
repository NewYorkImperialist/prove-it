"use client";
import { useEffect, useState } from "react";
import Card, { CardTitle, CardSub, StatusLine } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import TextInput from "@/components/ui/Field";
import { Crown } from "@/components/ui/Logo";
import { useCopied } from "@/hooks/useCopied";
import { copyText } from "@/lib/browser/clipboard";
import { DuelSettings, RaceSettings } from "./LobbySettings";

// Avatar tints, in join order.
export const AVATARS = ["var(--color-accent)", "#8a9aa0", "#5b8cff", "#e5484d", "#3ecf8e", "#b06bff", "#ff8c42", "#ffd34d"];

function PlayerRow({ player, index, isMe }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line bg-panel2 px-3.5 py-3">
      <div
        className="grid h-[34px] w-[34px] place-items-center rounded-[9px] font-black text-markfg"
        style={{ background: AVATARS[index % AVATARS.length] }}
      >
        {player.name[0].toUpperCase()}
      </div>
      <div className="flex-1 font-bold">
        {player.name}
        {player.crown ? <Crown /> : null}
        {isMe ? " (you)" : ""}
      </div>
      {player.connected === false ? (
        <span className="text-bad"> (reconnecting…)</span>
      ) : player.isHost ? (
        <span className="rounded-md bg-gold px-2 py-[3px] text-[11px] font-extrabold text-[#1a1a1a]">HOST</span>
      ) : null}
    </div>
  );
}

function EmptySlot({ label }) {
  return (
    <div className="flex items-center gap-3 rounded-[10px] border border-line border-dashed bg-panel2 px-3.5 py-3 font-medium text-muted italic">
      <div className="grid h-[34px] w-[34px] place-items-center rounded-[9px] bg-[#2a2f3e] font-black text-white">?</div>
      <div className="flex-1">{label}</div>
    </div>
  );
}

export default function WaitingRoom({ leaving, mp }) {
  const room = mp.room;
  const isRace = mp.mode === "race";
  const [codeHint, setCodeHint] = useState("tap the code to copy");
  const [inviteCopied, copyInvite] = useCopied(1500);
  const [lobbyName, setLobbyName] = useState("");

  const me = room?.players.find((p) => p.id === mp.myId);
  // Reflect the server's idea of my name, but never clobber what I'm typing.
  useEffect(() => {
    if (me && document.activeElement?.id !== "lobbyName") setLobbyName(me.name);
  }, [me]);

  const players = room?.players || [];
  const spectators = room?.spectators || [];
  const canStart = mp.iAmHost && players.length >= 2;

  const status = mp.isSpectator
    ? "You're spectating · waiting for the host to start…"
    : mp.iAmHost
      ? canStart
        ? ""
        : isRace
          ? "Waiting for at least one more racer…"
          : "Waiting for a second player…"
      : "Waiting for the host to start…";

  const tapCode = async () => {
    if (!mp.myRoom) return;
    await copyText(mp.myRoom);
    setCodeHint("✓ Code copied!");
    setTimeout(() => setCodeHint("tap the code to copy"), 1400);
  };

  return (
    <Card leaving={leaving}>
      <CardTitle>Waiting room</CardTitle>
      <CardSub>Share this code with your friend so they can join.</CardSub>

      <div className="mt-2 mb-3 text-center">
        <div
          onClick={tapCode}
          title="Click to copy"
          className="cursor-pointer rounded-[10px] font-mono text-[42px] font-black tracking-[8px] text-gold tabular-nums transition duration-[120ms] select-none hover:bg-panel2 active:scale-[.97]"
        >
          {room?.code || "----"}
        </div>
        <div className="text-xs text-muted">{codeHint}</div>
      </div>

      <Button
        variant="secondary"
        className="mb-3.5 w-full p-[11px]! text-sm!"
        onClick={() => copyInvite(`${window.location.origin}${window.location.pathname}?room=${mp.myRoom}`)}
      >
        {inviteCopied ? "✓ Invite link copied!" : "Copy invite link"}
      </Button>

      <div className="my-2 mb-[18px] flex flex-col gap-2">
        {players.map((p, i) => (
          <PlayerRow key={p.id} player={p} index={i} isMe={p.id === mp.myId} />
        ))}
        {players.length < 2 ? <EmptySlot label={isRace ? "waiting for more racers…" : "waiting for opponent…"} /> : null}
      </div>

      {spectators.length ? (
        <div className="mt-[-8px] mb-3.5 text-center text-xs text-muted">
          {spectators.length} watching · {spectators.map((s) => s.name).join(", ")}
        </div>
      ) : null}

      <div className="mb-3.5">
        <label htmlFor="lobbyName" className="mb-[5px] block text-xs text-muted">
          Your name
        </label>
        <TextInput
          id="lobbyName"
          maxLength={20}
          placeholder="e.g. Jayden"
          autoComplete="off"
          value={lobbyName}
          onChange={(e) => setLobbyName(e.target.value)}
          onBlur={() => mp.setName(lobbyName.trim())}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </div>

      {mp.crown.hasKey ? (
        <Button variant="ghost" className="mb-3.5 w-full" onClick={mp.toggleCrown}>
          👑 Crown: {mp.crown.on ? "on" : "off"}
        </Button>
      ) : null}

      {isRace ? (
        <RaceSettings settings={room?.settings} iAmHost={mp.iAmHost} onChange={mp.setRaceSettings} />
      ) : (
        <DuelSettings settings={room?.settings} iAmHost={mp.iAmHost} onChange={mp.setSettings} />
      )}

      {mp.iAmHost ? (
        <Button variant="primary" disabled={!canStart} onClick={mp.startMatch}>
          Start game
        </Button>
      ) : null}
      <StatusLine>{mp.errors.room || status}</StatusLine>
      <Button variant="ghost" className="mt-3.5 w-full" onClick={mp.leaveRoom}>
        Leave room
      </Button>
    </Card>
  );
}

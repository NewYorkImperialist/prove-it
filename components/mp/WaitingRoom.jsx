"use client";
import { useEffect, useState } from "react";
import Card, { CardTitle, CardSub, StatusLine, ErrorLine } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import TextInput from "@/components/ui/Field";
import { Crown } from "@/components/ui/Logo";
import { useCopied, useShareOrCopy } from "@/hooks/useCopied";
import SITE from "@/lib/site-config";
import { cx } from "@/lib/browser/cx";
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
  // The bare four-character code stays a clipboard copy and nothing else: a room code is not a
  // share payload — handed to an OS sheet it arrives as a text message reading "7K2P".
  const [codeCopied, copyCode, codeState] = useCopied(1400);
  const { done: invited, shared: inviteShared, failed: inviteFailed, native, run: sendInvite } = useShareOrCopy(1500);
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

  const tapCode = () => {
    if (mp.myRoom) copyCode(mp.myRoom);
  };

  // The link, not just the code: this is the one thing on the screen worth handing to a share
  // sheet, and the sheet wants the URL as its own field rather than buried in the message. The
  // clipboard still gets the bare URL, which is exactly what "Copy invite link" always gave.
  const invite = () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${mp.myRoom}`;
    return { title: SITE.siteName, text: `Join my ${SITE.siteName} room — code ${mp.myRoom}.`, url, copy: url };
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
        {/* The hint doubles as the confirmation, so a refused clipboard has somewhere to be said
            without adding a row to a card that is already the tallest in the lobby. It used to
            claim "✓ Code copied!" whatever the browser actually did with the write. */}
        <div className={cx("text-xs", codeState.failed ? "text-bad" : "text-muted")}>
          {codeState.failed ? "couldn't copy — read it out instead" : codeCopied ? "✓ Code copied!" : "tap the code to copy"}
        </div>
      </div>

      <Button variant="secondary" className={cx("w-full p-[11px]! text-sm!", inviteFailed ? "mb-0!" : "mb-3.5")} onClick={() => sendInvite(invite())}>
        {invited ? (inviteShared ? "✓ Invite sent!" : "✓ Invite link copied!") : native ? "Share invite link" : "Copy invite link"}
      </Button>
      {/* Conditional and tight: ErrorLine reserves a line even when empty, and this card already
          runs past the fold on a landscape phone before the settings block. */}
      {inviteFailed ? <ErrorLine className="mt-1 mb-2.5">Couldn&apos;t copy the link — share the code above instead.</ErrorLine> : null}

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

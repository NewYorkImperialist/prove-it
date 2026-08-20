"use client";
import Card, { CardTitle, CardSub, Divider, ErrorLine } from "@/components/ui/Card";
import Button, { BackButton } from "@/components/ui/Button";
import TextInput, { Label } from "@/components/ui/Field";

// Live Multiplayer: name yourself, then create, join or spectate a room.
export default function MpSetupCard({ leaving, mp, onBack }) {
  const name = mp.mpName.trim();
  const create = () => mp.createRoom(name);
  const join = () => mp.joinRoom(mp.joinCode, name);

  return (
    <Card leaving={leaving}>
      <BackButton onClick={onBack} />
      <CardTitle className="mt-0.5!">Live Multiplayer</CardTitle>
      <CardSub>Play head-to-head with a friend in real time.</CardSub>

      <Label htmlFor="mpName">Your name</Label>
      <TextInput
        id="mpName"
        autoFocus
        maxLength={20}
        placeholder="e.g. Jayden"
        autoComplete="off"
        value={mp.mpName}
        onChange={(e) => mp.setMpName(e.target.value)}
        onBlur={() => mp.rememberName(name)}
        onKeyDown={(e) => e.key === "Enter" && create()}
      />
      <Button variant="primary" onClick={create}>
        Create a room
      </Button>

      <Divider>or join a room</Divider>

      <Label htmlFor="joinCode">Room code</Label>
      <div className="flex gap-2">
        <TextInput
          id="joinCode"
          maxLength={4}
          placeholder="AB2D"
          autoComplete="off"
          className="flex-1 tracking-[2px] uppercase"
          value={mp.joinCode}
          onChange={(e) => mp.setJoinCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && join()}
        />
        <Button variant="secondary" onClick={join}>
          Join
        </Button>
      </div>

      <Button variant="ghost" className="mt-2 w-full" onClick={() => mp.spectateRoom(mp.joinCode, name)}>
        Spectate this room
      </Button>
      <ErrorLine>{mp.errors.home}</ErrorLine>
    </Card>
  );
}

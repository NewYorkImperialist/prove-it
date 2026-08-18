"use client";
import Card, { CardTitle, CardSub, Divider, ErrorLine, StatusLine } from "@/components/ui/Card";
import Button, { BackButton } from "@/components/ui/Button";
import TextInput, { Label } from "@/components/ui/Field";

// Challenge Race: everyone races the same category and clock, most correct takes the round.
// Quick Match drops you in a queue instead of trading a room code.
export default function RaceSetupCard({ leaving, mp, onBack }) {
  const name = mp.raceName.trim();
  const create = () => mp.createRoom(name, "race");
  const join = () => mp.joinRoom(mp.raceJoinCode, name, "race");

  return (
    <Card leaving={leaving}>
      <BackButton onClick={onBack} />
      <CardTitle className="mt-0.5!">Challenge Race</CardTitle>
      <CardSub>Everyone races the same category and clock — most correct wins the round.</CardSub>

      <Label htmlFor="raceName">Your name</Label>
      <TextInput
        id="raceName"
        autoFocus
        maxLength={20}
        placeholder="e.g. Jayden"
        autoComplete="off"
        value={mp.raceName}
        onChange={(e) => mp.setRaceName(e.target.value)}
        onBlur={() => mp.rememberName(name)}
        onKeyDown={(e) => e.key === "Enter" && create()}
      />
      <Button variant="primary" onClick={create}>
        Create a room
      </Button>
      <Button
        variant="secondary"
        className="mt-2.5 w-full"
        onClick={() => (mp.quickMatch.inQueue ? mp.leaveQuickMatch() : mp.joinQuickMatch(name))}
      >
        {mp.quickMatch.inQueue ? "Cancel Quick Match" : "Quick Match"}
      </Button>
      {mp.quickMatch.inQueue ? <StatusLine>{mp.quickMatch.status}</StatusLine> : null}

      <Divider>or join a room</Divider>

      <Label htmlFor="raceJoinCode">Room code</Label>
      <div className="flex gap-2">
        <TextInput
          id="raceJoinCode"
          maxLength={4}
          placeholder="ABCD"
          autoComplete="off"
          className="flex-1 tracking-[2px] uppercase"
          value={mp.raceJoinCode}
          onChange={(e) => mp.setRaceJoinCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && join()}
        />
        <Button variant="secondary" onClick={join}>
          Join
        </Button>
      </div>
      <ErrorLine>{mp.errors.race}</ErrorLine>
    </Card>
  );
}

"use client";
import { useState } from "react";
import { GENRES, GENRE_EMOJI, recommendedTime, CATS, nonSprint, shuffle, pickGenreRounds, geoChallengeCats, flagQuizCats } from "@/lib/solo-catalog";
import { BackButton } from "@/components/ui/Button";
import TextInput, { FieldLabel, Select } from "@/components/ui/Field";
import { Divider } from "@/components/ui/Card";
import Seg, { Stepper } from "@/components/ui/Seg";
import { SoloButton, SoloCard, SoloTitle, SoloSub, SoloErr } from "./SoloBits";
import CategorySelect from "./CategorySelect";

const ROUND_OPTIONS = [1, 3, 5, 10].map((n) => ({ value: n, label: String(n) }));
const TIME_PRESETS = [20, 30, 45, 60, 90].map((s) => ({ value: s, label: s + "s" }));
const INCREMENTS = [
  { value: 0, label: "0" },
  { value: 2, label: "+2s" },
  { value: 5, label: "+5s" },
];
const MODES = [
  { value: "genre", label: "One genre" },
  { value: "custom", label: "Custom rounds" },
];

// The solo builder: quick play, pick-a-category, or the full multi-round setup behind
// "Advanced settings".
export default function CreateSection({ solo, onBack }) {
  const [geoCat, setGeoCat] = useState(() => pickGenreRounds("Geography", 1)[0] || "");
  const [flagCat, setFlagCat] = useState(() => flagQuizCats()[0] || "");

  const quickPlay = () => {
    const c = shuffle(CATS.filter((x) => !nonSprint(x)))[0] || CATS[0];
    solo.startSolo([c.name], recommendedTime(c.name));
  };

  return (
    <SoloCard>
      <BackButton onClick={onBack} />
      <SoloTitle>Play solo</SoloTitle>
      <SoloSub>Name as many as you can before the clock runs out, then dare a friend to beat your score.</SoloSub>

      <FieldLabel htmlFor="byName">Your name</FieldLabel>
      <TextInput id="byName" type="text" maxLength={20} placeholder="e.g. Jayden" value={solo.byName} onChange={(e) => solo.setByName(e.target.value)} className="text-base!" />
      <SoloButton onClick={quickPlay} disabled={!!solo.busy}>
        {solo.busy === "starting" ? "Starting…" : "Quick play"}
      </SoloButton>

      <Divider>or</Divider>

      <FieldLabel htmlFor="catSel">Pick a category</FieldLabel>
      <div className="flex items-stretch gap-2.5">
        <CategorySelect id="catSel" value={solo.quickCat} onChange={solo.setQuickCat} className="min-w-0 flex-1" />
        <SoloButton
          variant="ghost"
          className="mt-0! w-auto! shrink-0 px-6"
          disabled={!!solo.busy}
          onClick={() => solo.quickCat && solo.startSolo([solo.quickCat], recommendedTime(solo.quickCat))}
        >
          Play
        </SoloButton>
      </div>

      <Divider>or</Divider>

      {/* Defaults to a random geography category at its own recommended time — no setup beyond
          picking one, and it lands straight on that category's leaderboard. */}
      <FieldLabel htmlFor="geoSel">Geography challenge</FieldLabel>
      <div className="flex items-stretch gap-2.5">
        <Select id="geoSel" value={geoCat} onChange={(e) => setGeoCat(e.target.value)} className="min-w-0 flex-1">
          {geoChallengeCats().map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </Select>
        <SoloButton
          variant="ghost"
          className="mt-0! w-auto! shrink-0 px-6"
          disabled={!!solo.busy}
          onClick={() => geoCat && solo.startGeoChallenge(geoCat)}
        >
          {solo.busy === "starting" ? "…" : "Play"}
        </SoloButton>
      </div>

      <Divider>or</Divider>

      <FieldLabel htmlFor="flagSel">Flags quiz</FieldLabel>
      <div className="flex items-stretch gap-2.5">
        <Select id="flagSel" value={flagCat} onChange={(e) => setFlagCat(e.target.value)} className="min-w-0 flex-1">
          {flagQuizCats().map((n) => (
            <option key={n} value={n}>{n === "Flags of the World" ? "World" : n.replace("Flags of ", "")}</option>
          ))}
        </Select>
        <SoloButton
          variant="ghost"
          className="mt-0! w-auto! shrink-0 px-6"
          disabled={!!solo.busy}
          onClick={() => flagCat && solo.startFlagQuiz(flagCat)}
        >
          Play
        </SoloButton>
      </div>

      <button
        type="button"
        onClick={() => solo.setAdvOpen(!solo.advOpen)}
        className="mx-auto mt-[18px] mb-0.5 block w-auto cursor-pointer border-none bg-transparent px-2.5 py-1.5 font-mono text-xs font-semibold tracking-[.4px] text-muted hover:text-accent"
      >
        Advanced settings ▾
      </button>

      {solo.advOpen ? (
        <div>
          <Seg className="mt-3" options={MODES} value={solo.mode} onChange={solo.setMode} />

          <FieldLabel>Rounds</FieldLabel>
          <Seg options={ROUND_OPTIONS} value={solo.numRounds} onChange={solo.setNumRounds} />

          <FieldLabel>Time per round</FieldLabel>
          <Seg options={TIME_PRESETS} value={solo.perRound} onChange={solo.setPerRound} />
          <Stepper value={solo.perRound} onChange={solo.setPerRound} min={5} max={1800} step={5} ariaLess="less time" ariaMore="more time" />

          <FieldLabel>Time increment per correct answer</FieldLabel>
          <Seg options={INCREMENTS} value={solo.increment} onChange={solo.setIncrement} />
          <Stepper value={solo.increment} onChange={solo.setIncrement} ariaLess="less increment" ariaMore="more increment" />

          {solo.mode === "genre" ? (
            <div>
              <FieldLabel htmlFor="genreSel">Genre (a random category each round)</FieldLabel>
              <Select id="genreSel" value={solo.genre} onChange={(e) => solo.setGenre(e.target.value)}>
                {GENRES.map((g) => (
                  <option key={g} value={g}>
                    {GENRE_EMOJI[g]} {g}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div>
              <FieldLabel>Pick each round&apos;s category</FieldLabel>
              {solo.customRounds.map((name, i) => (
                <div key={i} className="mb-2">
                  <div className="mb-1 font-mono text-[11px] text-muted">Question {i + 1}</div>
                  <CategorySelect
                    value={name}
                    onChange={(v) => solo.setCustomRounds(solo.customRounds.map((x, j) => (j === i ? v : x)))}
                  />
                </div>
              ))}
            </div>
          )}

          <SoloButton onClick={solo.createChallenge} disabled={!!solo.busy}>
            {solo.busy === "creating" ? "Creating…" : "Start"}
          </SoloButton>
        </div>
      ) : null}

      <SoloErr>{solo.createErr}</SoloErr>
    </SoloCard>
  );
}

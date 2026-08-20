"use client";
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import TextInput from "@/components/ui/Field";
import { ErrorLine } from "@/components/ui/Card";
import { getJSON } from "@/lib/browser/api";
import { geoBoardCats } from "@/lib/solo-catalog";
import { dailyInvite, playedDailyToday, submitDailyResult } from "@/lib/browser/daily";
import * as store from "@/lib/browser/storage";
import { useCopied } from "@/hooks/useCopied";
import { cx } from "@/lib/browser/cx";
import ChallengeBoard from "./ChallengeBoard";
import CategoryBoard from "./CategoryBoard";
import DailyAllTimeBoard from "./DailyAllTimeBoard";
import GoatBoard from "./GoatBoard";
import { LbNote } from "./table";

const TABS = [
  { key: "today", label: "Daily" },
  { key: "alltime", label: "All-time" },
  { key: "cat", label: "Geography" },
  { key: "goat", label: "🐐 GOAT" },
];

// The laurel modal. Four boards behind tabs, plus (on the daily tab, once you've played today)
// the ability to rewrite the name on your entry and share your score.
export default function LeaderboardModal({ onClose, visitorId }) {
  const [tab, setTab] = useState("today");
  const [catName, setCatName] = useState(() => geoBoardCats()[0] || "");
  const [today, setToday] = useState(null); // { id, date } once /daily resolves
  const [name, setName] = useState(() => store.getSoloName());
  const [nameErr, setNameErr] = useState("");
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [copied, copy] = useCopied(2200);

  const played = playedDailyToday();
  const geoCats = useMemo(() => geoBoardCats(), []);

  // Escape closes it, like the backdrop and the × do. Without this the modal was a dead end for
  // anyone who reaches for the key first.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The daily tab needs today's id; asking /daily also makes sure the puzzle exists.
  useEffect(() => {
    if (tab !== "today" || today) return;
    let live = true;
    getJSON("/daily").then((d) => {
      if (live && d && d.ok) setToday({ id: d.id, date: d.date });
      else if (live) setToday({ error: true });
    });
    return () => {
      live = false;
    };
  }, [tab, today]);

  // The category tab's picker only offers the geography categories that HAVE a board (geoBoardCats
  // — 13 of the 23), so it can't claim a board "per category": counting the ones on offer keeps the
  // promise the size of the picker even as categories come and go.
  const title =
    tab === "alltime" ? "Highest daily score, all time"
    : tab === "cat" ? `All-time best · ${geoCats.length} geography boards`
    : tab === "goat" ? "Geography GOAT · every category, ranked"
    : today && today.date ? `Today's puzzle · ${today.date}`
    : "";

  const save = async () => {
    setNameErr("");
    if (!name.trim()) return;
    setSaving(true);
    const res = await submitDailyResult({ name, run: null, challengeId: today?.id, visitorId });
    setSaving(false);
    if (res.blocked) return setNameErr("That name isn't allowed — try a different one.");
    if (res.ok) setReloadKey((k) => k + 1);
  };

  return (
    <div
      className="fixed inset-0 z-100 grid place-items-center bg-[rgba(8,7,4,.72)] p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* overflow-x-hidden: the boards scroll sideways on their own (see LbTable). Letting the
          modal body do it too dragged this close button and the tabs off-screen with the table. */}
      <div className="relative max-h-[88vh] w-[min(94vw,520px)] overflow-y-auto overflow-x-hidden rounded-2xl border border-line bg-panel px-4 pt-6 pb-[26px] shadow-[0_24px_70px_rgba(0,0,0,.6)] desk:px-6">
        <button
          type="button"
          title="Close"
          aria-label="Close"
          onClick={onClose}
          // A 25×26 glyph is a miss waiting to happen on a phone, and the backdrop either side of
          // the card is only ~10px wide at 320, so tapping "outside" isn't a real escape route.
          className="absolute top-1 right-1 z-10 grid h-11 w-11 cursor-pointer place-items-center border-none bg-transparent text-[26px] leading-none text-muted hover:text-accent"
        >
          ×
        </button>

        <div className="mt-0.5 mr-11 mb-3.5 flex gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cx(
                "min-h-11 flex-1 cursor-pointer rounded-[9px] border px-[5px] py-[9px] text-xs font-bold whitespace-nowrap",
                tab === t.key ? "border-accent bg-accent text-markfg" : "border-line2 bg-panel2 text-muted",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "cat" ? (
          <select value={catName} onChange={(e) => setCatName(e.target.value)} className="mb-3 w-full cursor-pointer rounded-[10px] border border-line2 bg-bg py-[9px] pr-[38px] pl-3 text-sm text-ink outline-none">
            {geoCats.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        ) : null}

        {title ? <LbNote className="mt-0 mb-3">{title}</LbNote> : null}

        <div>
          {tab === "today" ? (
            today == null ? <LbNote>Loading…</LbNote>
            : today.error ? <LbNote>Couldn&apos;t load today&apos;s leaderboard.</LbNote>
            : <ChallengeBoard id={today.id} visitorId={visitorId} reloadKey={reloadKey} />
          ) : null}
          {tab === "alltime" ? <DailyAllTimeBoard visitorId={visitorId} /> : null}
          {tab === "cat" ? <CategoryBoard name={catName} visitorId={visitorId} /> : null}
          {tab === "goat" ? <GoatBoard visitorId={visitorId} /> : null}
        </div>

        {/* Rewriting your name applies to today's board only, and only once you've played. */}
        {tab === "today" && played ? (
          <div>
            <LbNote className="mt-3.5 mb-1.5">You&apos;re on today&apos;s board — rewrite your name anytime:</LbNote>
            <div className="mb-2.5 flex gap-2">
              <TextInput
                value={name}
                maxLength={20}
                placeholder="Your name"
                onChange={(e) => setName(e.target.value)}
                shake={!!nameErr}
                className="min-w-0 flex-1 border-line2"
              />
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="shrink-0 cursor-pointer rounded-[10px] border-none bg-accent px-4 text-sm font-extrabold text-markfg disabled:opacity-50"
              >
                {saving ? "Saving…" : "Update my entry"}
              </button>
            </div>
            <ErrorLine>{nameErr}</ErrorLine>
          </div>
        ) : null}

        {tab === "today" && played ? (
          <Button variant="primary" onClick={() => copy(dailyInvite(store.getDailyScore(), today?.id))}>
            {copied ? "Copied — send it to a friend!" : "Share your score & invite friends"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

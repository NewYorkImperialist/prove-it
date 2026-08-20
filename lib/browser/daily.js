// Daily-challenge plumbing shared by the solo run and the laurel leaderboard modal.
import { postJSON, isNameBlocked } from "@/lib/browser/api";
import { todayEastern } from "@/lib/format";
import * as store from "@/lib/browser/storage";

export const playedDailyToday = () => store.getDailyLast() === todayEastern();

// Today's daily id, derived the same way the server derives it (routes/challenge.js).
export const todaysDailyId = () => "d-" + todayEastern().replace(/-/g, "");

// `by`: the sharer's own name, if known — shows up as "[name] says…" in the link preview
// instead of the generic "Daily" placeholder (see routes/challenge.js's /challenge.html).
export const dailyLinkUrl = (challengeId, by) => {
  const base = `${window.location.origin}/challenge.html?id=${challengeId || todaysDailyId()}`;
  const name = String(by || "").trim().slice(0, 24);
  return name ? `${base}&by=${encodeURIComponent(name)}` : base;
};

export function dailyInvite(score, challengeId, by) {
  const s = score != null && score !== "" && !isNaN(Number(score)) ? `I named ${score} on today's Prove It! daily challenge. ` : "";
  return `${s}Think you can beat me? Play today's daily: ${dailyLinkUrl(challengeId, by)}`;
}

// Always crown the creator's runs when this device holds the owner key (independent of the
// multiplayer crown toggle), so every run collapses into ONE creator entry on the boards.
export const ownerKeyIfCrowned = () => store.getOwnerKey();

// Opt-in arcade leaderboard submit/update. Resubmittable: the server keeps the best total and
// the newest name. Uses the run just played when we have it, else the one persisted in
// localStorage — which is what lets the modal rename your entry later the same day.
// Returns { ok: true, name }, { ok: false, blocked: true } when the name is rejected, or
// { ok: false, error } when the write itself failed.
export async function submitDailyResult({ name, run, challengeId, visitorId }) {
  const n = String(name || "").trim().slice(0, 20);
  if (!n) return { ok: false };
  if (await isNameBlocked(n)) return { ok: false, blocked: true };
  store.setSoloName(n);

  let payload = run;
  if (!payload) {
    const saved = store.getDailyRun();
    if (saved && saved.date === todayEastern()) payload = { scores: saved.scores || [], wpms: saved.wpms || [], times: saved.times || [], gid: saved.gid || "" };
  }
  const id = challengeId || todaysDailyId();
  const ownerKey = ownerKeyIfCrowned();
  const res = await postJSON(`/challenge/${id}/result`, {
    name: n,
    scores: payload?.scores || [],
    wpms: payload?.wpms || [],
    times: payload?.times || [],
    visitorId,
    ownerKey,
    gid: payload?.gid || "",
  });
  // routes/challenge.js answers { ok: false } when persistence is off or the day's row has
  // gone; this used to be discarded and the caller told "you're on the board" regardless.
  if (!res.ok) return { ok: false, error: res.error || "Couldn't save your score — check your connection and try again." };
  // Propagate the new name to ALL of this player's entries everywhere (and every crowned row,
  // for the creator), so one rename fixes every board. Best-effort: the score is already in,
  // so a failed rename isn't worth failing the submit over.
  await postJSON("/challenge/rename", { name: n, visitorId, ownerKey });
  return { ok: true, name: n };
}

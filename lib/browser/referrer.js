// Where this visit came from, captured ONCE at module load.
//
// Timing is the whole reason this is a module and not two expressions inside the socket's connect
// handler. Two things would otherwise destroy the value:
//   1. the app rewrites its own URL with history.replaceState (adding/stripping ?id=, ?crown=), so
//      a campaign query like ?utm_source=reddit is frequently gone from location.href within a
//      few hundred ms of the page loading — well before the socket finishes connecting;
//   2. SocketProvider's connect handler also runs on every RECONNECT (a phone waking up, a deploy
//      restarting the server), and a reconnect ten minutes into a session must still report where
//      the visitor originally arrived from, not wherever they've navigated to since.
// Module scope runs at bundle load, before the first render and therefore before any of those
// rewrites, and the snapshot is frozen from then on.
//
// Only the RAW values are captured; lib/referral.js turns them into a channel label server-side,
// so the labelling can be improved without shipping a new client bundle.

// Referrers can be arbitrarily long (a search URL with a page of query parameters). Clamped here
// as well as on the server: no reason to put a kilobyte on the wire for an analytics field.
const MAX = 300;

// `typeof window` because this module is imported by a "use client" component, whose module body
// still evaluates during Next's server render — where there is no document. The browser re-evaluates
// it for real, which is the only pass whose values matter.
const grab = (fn) => {
  try {
    return typeof window === "undefined" ? "" : String(fn() || "").slice(0, MAX);
  } catch {
    return ""; // analytics only — nothing here may break the page
  }
};

const arrival = Object.freeze({
  referrer: grab(() => document.referrer),
  landing: grab(() => window.location.href),
});

// The frozen snapshot: { referrer, landing }. Same object every call, by design.
export const arrivedFrom = () => arrival;

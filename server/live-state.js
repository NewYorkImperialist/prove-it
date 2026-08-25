"use strict";
// The bridge between the Express server's live memory and the Next-rendered admin pages.
//
// Why this exists at all: the dashboard reports on state that only exists in one place — the `rooms`
// Map, the Socket.IO server, the cost guard's tripped flags, the in-process counters. All of it lives
// in the closure `createRooms()` returned to server/index.js. A Next server component that required
// server/rooms.js would call `createRooms` again and get a brand-new, permanently empty Map, and the
// dashboard would render a plausible-looking page saying nobody is online. A silently wrong report is
// worse than a broken one, which is the whole reason this module is explicit rather than a require.
//
// `globalThis` is the seam, and it works because Next runs IN this process (server/index.js creates
// it with next({dev}) and hands requests to its handler) rather than as a separate server. Verified
// rather than assumed: a probe route in the Next bundle read back exactly the keys published here.
//
// Symbol-keyed so nothing can collide with it by accident, and so it doesn't show up in a casual
// Object.keys(globalThis) dump.
const KEY = Symbol.for("proveit.liveState");

// Called once, from server/index.js, after createRooms(). Everything the admin surface needs from
// live memory goes through here — if a new page needs another handle, it gets added to this call
// rather than requiring its way to it.
function publishLiveState(state) {
  globalThis[KEY] = state;
}

// Read side, for the admin pages and action handlers.
//
// Throws rather than returning null or {}. This is the one failure mode that matters here: if the
// bridge is ever broken — a refactor that stops calling publishLiveState, a build that somehow
// isolates the two module graphs — every dashboard would otherwise render as "0 rooms, 0 online,
// nothing wrong". An error page is a bug report; an empty dashboard is a lie.
function liveState() {
  const s = globalThis[KEY];
  if (!s) {
    throw new Error(
      "live server state is not published — server/index.js must call publishLiveState() before " +
      "any /admin page renders. Rendering the dashboard without it would report an empty server.",
    );
  }
  return s;
}

// For tests and for any caller that would rather branch than catch.
const hasLiveState = () => !!globalThis[KEY];

module.exports = { publishLiveState, liveState, hasLiveState };

"use strict";
// Rules that both the server and the player-facing view builders have to agree on.
//
// GRACE_MS lived only in server/rooms.js while lib/duel-view.js and lib/race-view.js each wrote
// "waiting up to 30s for them to reconnect…" as a literal. The number happened to match, so the
// screen was right by luck: changing the server's grace window would have left both views quietly
// lying about how long a disconnected player has. The server sends graceMs on `opponentStatus`
// too, which nothing read.
const GRACE_MS = 30000; // how long a disconnected player keeps their seat before forfeiting

module.exports = { GRACE_MS };

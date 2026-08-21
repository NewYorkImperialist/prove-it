"use strict";
// The secret that proves a multiplayer seat belongs to you.
//
// Seats used to be claimable by anyone who knew the seat's `playerId` — and `roomState` broadcasts
// every player's id to everyone in the room, spectators included, so that id was public. Spectate a
// room, read the roster, emit `resume` with someone else's id, and you held their seat: their chat
// identity, the host's authority if they were host, and `leaveRoom` made THEM forfeit their match.
//
// Same mistake as the leaderboard's `visitor_id`: an identifier that says *who you are* is not
// evidence that *you are them*. The id can stay public — this is what must not be. It is handed
// only to the socket that took the seat (in the createRoom/joinRoom/resume ack, or in
// quickMatchFound) and never appears in a broadcast.
//
// Its own module because both server/rooms.js and server/matchmaking.js seat players, and a seat
// minted without a token would be a seat nobody could ever reclaim.
const crypto = require("node:crypto");

const newSeatToken = () => crypto.randomBytes(24).toString("base64url");

// Constant-time, and false rather than a throw on anything that isn't a same-length string —
// timingSafeEqual rejects mismatched buffer lengths, so the length check has to come first.
function seatTokenOk(seat, token) {
  const want = seat && seat.token ? String(seat.token) : "";
  const got = typeof token === "string" ? token : "";
  if (!want || want.length !== got.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

module.exports = { newSeatToken, seatTokenOk };

import { io } from "socket.io-client";

// One connection per tab, created lazily on first use and never torn down: the whole app
// (lobby, duel, race, spectating) shares it, and React remounts must not reconnect.
let socket = null;
export function getSocket() {
  if (!socket) socket = io();
  return socket;
}

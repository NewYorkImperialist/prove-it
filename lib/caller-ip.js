"use strict";
// Who is asking, as well as this app can tell.
//
// Fly terminates TLS and puts the real client in fly-client-ip; x-forwarded-for is the generic
// fallback for any other proxy; req.ip is what's left when nothing is in front.
//
// Every one of those is attacker-controlled, so this is a way to BUCKET requests, not to identify
// anyone. Rate limits built on it are speed bumps against a script — someone willing to rotate
// headers or addresses gets past them, and no limit keyed on a client-supplied value can be more
// than that. The things that actually have to hold (the owner key comparison, the score checks) do
// not depend on this being honest.
//
// One copy, because routes/challenge.js's write limiter and lib/owner-auth.js's failed-auth limiter
// must bucket the same caller the same way — two subtly different notions of "the caller" would mean
// a limit that looks enforced and isn't.
function callerIp(req) {
  if (!req || typeof req.get !== "function") return "unknown";
  return req.get("fly-client-ip")
    || String(req.get("x-forwarded-for") || "").split(",")[0].trim()
    || req.ip
    || "unknown";
}

module.exports = { callerIp };

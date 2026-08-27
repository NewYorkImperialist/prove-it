import { notFound } from "next/navigation";
import { ownerOk } from "@/lib/owner-auth";

// The key gate for the Next-rendered admin pages.
//
// Lives here rather than in lib/ because lib/**/*.js is CommonJS in eslint.config.js (those modules
// are shared with the Express server), and this one imports next/navigation. A non-route file inside
// app/ creates no route, so colocating it next to the only pages that use it costs nothing.
//
// 404, not 401 or 403. An unauthenticated visitor should not be able to learn that /admin exists,
// and a 403 confirms it — which is why the Express version answered `res.status(404).send("Not
// found")` on every one of its twenty-four routes. notFound() renders the app's own not-found page,
// so the two behave the same from outside.
//
// ownerOk() takes a request-shaped object; a Next page gets searchParams instead, so this adapts
// rather than reimplementing the comparison. The constant-time compare and the "an unset env var
// never matches" rule live in lib/owner-auth.js and must not be duplicated here — a second copy of
// an auth check is a second thing to get wrong.
// The request shape ownerOk() wants, built from real headers.
//
// The headers are not decoration. ownerOk buckets its failed-attempt throttle on the caller's
// address (lib/caller-ip.js), and this adapter used to pass `get: () => undefined` — so every
// failure on a Next admin route landed in one shared "unknown" bucket. Nine wrong keys from
// anyone on the internet, and the block applied to the OWNER's correct key too, for fifteen
// minutes. That is precisely the lockout the per-address rule exists to prevent, and
// test/admin-throttle.test.js asserts it can't happen: the Express side honours it and this
// adapter quietly broke it.
const asRequest = (key, headerList) => ({
  query: { key },
  get: (h) => headerList?.get?.(h) ?? undefined,
});

// `headerList` is the result of `headers()` from next/headers — pass it from the page, which is
// the only place that can call it. Without one this still fails closed, it just shares a bucket.
export function requireOwner(searchParams, headerList) {
  const raw = searchParams?.key;
  // A repeated ?key=a&key=b arrives as an array. ownerOk rejects a non-string outright, so this
  // would already fail closed; taking the first value keeps the behaviour identical to Express's
  // req.query, which does the same.
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!ownerOk(asRequest(key, headerList))) notFound();
  return typeof key === "string" ? key : "";
}

// Same gate for the action route handlers, which get a Request rather than searchParams. Returns
// the key on success and null when the caller should 404 — a handler can't call notFound().
export function ownerKeyFrom(request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!ownerOk(asRequest(key, request.headers))) return null;
  return key || "";
}

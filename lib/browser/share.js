// The OS share sheet, where the platform actually has one. `navigator.share` is a phone API
// first — every iOS/Android browser has it, Safari on the Mac has it, desktop Chrome and Firefox
// do not — so nothing here can be the only way to send a link. Every caller pairs it with the
// clipboard (lib/browser/clipboard.js) and this module's job is to say, honestly, which of the
// two just happened.
//
// Best-effort like the rest of lib/browser: a missing API, a payload the browser won't take, or
// a sheet that never opens must never break the screen the button is sitting on.

// Whether a share sheet is worth offering. Pass the payload when you have one.
//
// `navigator.canShare(data)` is the only reliable per-payload check: `navigator.share` exists on
// browsers that will still reject the specific thing you hand it (a file, or on some builds a
// bare `url`), and the way they report that is by throwing at click time — too late to have
// labelled the button "Copy". Where canShare is missing (older Safari) the presence of share()
// is all there is to go on, which is why the payload argument is optional: called bare, this is
// the capability question a label needs at render time.
export function canShare(data) {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  try {
    if (data && typeof navigator.canShare === "function") return navigator.canShare(data);
  } catch {
    return false; // a canShare that throws is not a sheet we want to try opening
  }
  return true;
}

// Drop empties rather than pass them through: a ShareData member set to "" is shown by some
// sheets as an empty title/message, and `undefined` here would only be ignored by luck.
const clean = (data) => {
  const out = {};
  for (const k of ["title", "text", "url"]) {
    const v = data && data[k];
    if (typeof v === "string" && v.trim()) out[k] = v;
  }
  return out;
};

// Open the sheet. Returns one of three tags, deliberately NOT a boolean:
//
//   "shared"      — the sheet took it. Confirm it in the UI.
//   "cancelled"   — the player opened the sheet and backed out (AbortError). This is a finished
//                   decision, not a failure: the button has to go back to exactly how it looked,
//                   with no "Shared!" and no error. Telling someone the share failed because
//                   they changed their mind is a lie, and offering to copy instead second-guesses
//                   them.
//   "unsupported" — there is no sheet, or the browser refused this payload, or it refused the
//                   call (NotAllowedError: outside a user gesture, or a share already open).
//                   Fall back to the clipboard.
//
// A boolean would force callers to fold "cancelled" into one of the other two, and both readings
// are wrong — which is the whole reason this returns a string.
//
// Call this straight out of the click handler with nothing awaited first: `navigator.share`
// requires transient user activation, and one stray `await` ahead of it spends that.
export async function share(data) {
  const payload = clean(data);
  if (!payload.title && !payload.text && !payload.url) return "unsupported";
  if (!canShare(payload)) return "unsupported";
  try {
    await navigator.share(payload);
    return "shared";
  } catch (err) {
    return err && err.name === "AbortError" ? "cancelled" : "unsupported";
  }
}

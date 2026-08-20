"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/browser/clipboard";
import { canShare, share } from "@/lib/browser/share";

const RESTING = { done: false, shared: false, failed: false };

// One handler behind every "send this to a friend" button: the OS share sheet where the browser
// has one, the clipboard everywhere else. Deliberately ONE control rather than a share button
// next to a copy button — five screens each carrying two near-identical actions is clutter, and
// on a phone (where sharing actually happens) the sheet is the only one of the two anybody wants.
//
// As with the old hook below, the caller owns every label. What this reports is which of the
// three things happened, because they need different words:
//   • `native`  — say "Share" instead of "Copy": there is a sheet to open.
//   • `done`    — the confirmed window, with `shared` telling you whether to confirm a share or
//                 a copy. Claiming "Copied!" after a share sheet posted to Instagram is a lie.
//   • `failed`  — the copy was refused (a locked-down browser, a denied clipboard permission).
//                 This is the bug this hook shipped with: the boolean from copyText was thrown
//                 away, so a player whose clipboard is blocked was told the link was on it.
//
// `failed` deliberately has no timer. A confirmation should get out of the way; an error that
// erases itself after two seconds is one a player can miss entirely, and the next attempt (or a
// successful one) clears it anyway.
export function useShareOrCopy(ms = 2000) {
  const [state, setState] = useState(RESTING);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  // Whether a sheet exists can only be answered after mount: this renders on the server too,
  // where there is no navigator, and a label that disagrees with the server's HTML is a
  // hydration mismatch. So the button says "Copy" for the first paint and corrects itself — the
  // wrong way round would be worse, since the fallback is what the majority of visitors get.
  const [native, setNative] = useState(false);
  useEffect(() => setNative(canShare()), []);

  const flash = useCallback(
    (next) => {
      setState(next);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState(RESTING), ms);
    },
    [ms],
  );

  // `payload`: { title, text, url } for the sheet, plus `copy` — the one flat string to put on
  // the clipboard instead (the sheet keeps the link out of the message body; a paste needs it in
  // there). `prefer: "copy"` opts a caller out of the sheet entirely, which is what a bare room
  // code wants: four characters are not a share payload.
  const run = useCallback(
    async (payload) => {
      const { title, text, url, copy, prefer } = payload || {};
      // Nothing may be awaited before share(): navigator.share needs the click's user activation
      // and a single intervening await spends it (see lib/browser/share.js).
      const outcome = prefer === "copy" ? "unsupported" : await share({ title, text, url });
      // Cancelling the sheet is a completed decision, not a failure. Back to resting: no
      // confirmation, no error, and no copying to the clipboard behind their back either.
      if (outcome === "cancelled") {
        clearTimeout(timer.current);
        return setState(RESTING);
      }
      if (outcome === "shared") return flash({ done: true, shared: true, failed: false });
      const ok = await copyText(copy || [text, url].filter(Boolean).join(" "));
      if (!ok) {
        clearTimeout(timer.current);
        return setState({ done: false, shared: false, failed: true });
      }
      flash({ done: true, shared: false, failed: false });
    },
    [flash],
  );

  return { ...state, native, run };
}

// "Copy" buttons that flip to a confirmation for a beat, then flip back. The caller owns both
// labels; this only tracks whether we're in the confirmed window. No share sheet — this is for
// the things that are only ever a clipboard copy — and the third element carries the failure a
// caller can now honestly report.
export function useCopied(ms = 2000) {
  const { done, failed, run } = useShareOrCopy(ms);
  const copy = useCallback((text) => run({ copy: text, prefer: "copy" }), [run]);
  return [done, copy, { failed }];
}

"use client";
import { useCallback, useMemo, useRef, useState } from "react";

const LEAVE_MS = 210; // matches the view-leave keyframe in app/globals.css

// Top-level screen router. `go` cuts straight to a view (cards still fly in on mount, which
// is how the vanilla build's show() behaved); `leaveTo` first flies the current card away,
// for the deliberate back-and-forth between the menu, the setup cards and solo.
export function useCardRouter(initial = "home") {
  const [view, setView] = useState(initial);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef(null);

  const go = useCallback((next) => {
    clearTimeout(timer.current);
    setLeaving(false);
    setView(next);
  }, []);

  const leaveTo = useCallback((next) => {
    clearTimeout(timer.current);
    setLeaving(true);
    timer.current = setTimeout(() => {
      setLeaving(false);
      setView(next);
    }, LEAVE_MS);
  }, []);

  // Memoised: effects elsewhere depend on the router, and a fresh object each render would
  // re-run them (and, for anything that navigates, loop).
  return useMemo(() => ({ view, leaving, go, leaveTo }), [view, leaving, go, leaveTo]);
}

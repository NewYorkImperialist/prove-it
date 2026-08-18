"use client";
import { useCallback, useRef, useState } from "react";

// State plus a ref that's always current. Socket handlers are registered once and live for
// the life of the tab, so they read through the ref instead of closing over a stale value.
export function useStateRef(initial) {
  const [state, setState] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((v) => {
    ref.current = typeof v === "function" ? v(ref.current) : v;
    setState(ref.current);
  }, []);
  return [state, set, ref];
}

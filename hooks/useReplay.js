"use client";
import { useEffect, useState } from "react";

// Re-run a one-shot CSS animation every time `trigger` changes. The class is dropped for one
// frame first, which is the React equivalent of the classList/offsetWidth reflow dance.
export function useReplay(trigger) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!trigger) return undefined;
    setOn(false);
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, [trigger]);
  return [on, () => setOn(false)];
}

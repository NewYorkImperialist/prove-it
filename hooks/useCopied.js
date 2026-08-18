"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "@/lib/browser/clipboard";

// "Copy" buttons that flip to a confirmation for a beat, then flip back. The caller owns both
// labels; this only tracks whether we're in the confirmed window.
export function useCopied(ms = 2000) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text) => {
      await copyText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), ms);
    },
    [ms],
  );

  return [copied, copy];
}

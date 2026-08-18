"use client";
import { useEffect } from "react";

// Keep the full-screen layouts sized to the *visible* viewport, so the mobile keyboard
// (opened for chat or answers) shrinks the feed instead of hiding the header and input bar.
// iOS also shifts the visible area down, hence --app-top.
export function useAppHeight(onResize) {
  useEffect(() => {
    const apply = () => {
      const vv = window.visualViewport;
      const h = (vv && vv.height) || window.innerHeight;
      const top = (vv && vv.offsetTop) || 0;
      const s = document.documentElement.style;
      s.setProperty("--app-height", h + "px");
      s.setProperty("--app-top", top + "px");
      if (onResize) onResize();
    };
    apply();
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      if (vv) {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      }
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, [onResize]);
}

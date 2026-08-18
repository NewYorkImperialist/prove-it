"use client";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "@/lib/browser/socket";
import { armAudio } from "@/lib/browser/sfx";
import { visitorId } from "@/lib/browser/storage";

const SocketContext = createContext(null);
export const useSocketCtx = () => useContext(SocketContext);

// Owns the things every screen shares: the connection itself, the connection indicator,
// the live "N online" count, and the owner's broadcast banner.
export default function SocketProvider({ children }) {
  const socket = useMemo(() => getSocket(), []);
  const [conn, setConn] = useState({ text: "connecting…", ok: false });
  const [online, setOnline] = useState(0);
  const [announce, setAnnounce] = useState(null);
  const pingRef = useRef(null);
  const announceTimer = useRef(null);

  useEffect(() => {
    armAudio(); // browsers block audio until a gesture; resume on the first one

    const label = () => (pingRef.current == null ? "connected" : `connected · ${pingRef.current}ms`);
    const measure = () => {
      if (!socket.connected) return;
      const t0 = performance.now();
      socket.emit("latencyPing", () => {
        pingRef.current = Math.max(1, Math.round(performance.now() - t0));
        setConn((c) => (c.ok ? { text: label(), ok: true } : c));
      });
    };

    const onConnect = () => {
      setConn({ text: "connected", ok: true });
      measure();
      // Persistent anonymous visitor id + timezone/locale → owner analytics.
      try {
        socket.emit("clientMeta", { visitorId: visitorId(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language });
      } catch {
        /* analytics only — never block connecting */
      }
    };
    const onDisconnect = () => setConn({ text: "reconnecting…", ok: false });
    const onError = () => setConn({ text: "connection error", ok: false });
    const onPresence = ({ online: n }) => setOnline(n || 0);
    const onAnnounce = ({ text }) => {
      setAnnounce(text);
      clearTimeout(announceTimer.current);
      announceTimer.current = setTimeout(() => setAnnounce(null), 45000);
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onError);
    socket.on("presence", onPresence);
    socket.on("announce", onAnnounce);
    if (socket.connected) onConnect();
    const iv = setInterval(measure, 4000);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onError);
      socket.off("presence", onPresence);
      socket.off("announce", onAnnounce);
      clearInterval(iv);
      clearTimeout(announceTimer.current);
    };
  }, [socket]);

  const value = useMemo(() => ({ socket, conn, online, announce, dismissAnnounce: () => setAnnounce(null) }), [socket, conn, online, announce]);
  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

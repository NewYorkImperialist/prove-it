"use client";
import { useEffect, useRef } from "react";

const COLORS = ["#ffd34d", "#3ecf8e", "#5b8cff", "#e5484d", "#b06bff", "#ff8c42"];

// Self-contained canvas confetti — no library. Bursts from the top-centre and rains down;
// `trigger` firing again starts a fresh burst.
export default function Confetti({ trigger }) {
  const canvasRef = useRef(null);
  const raf = useRef(0);

  useEffect(() => {
    if (!trigger) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d");

    const parts = Array.from({ length: 180 }, () => ({
      x: canvas.width / 2 + (Math.random() - 0.5) * 240,
      y: canvas.height / 3 + (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 14,
      vy: Math.random() * -13 - 3,
      size: 6 + Math.random() * 7,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
    }));

    let frame = 0;
    const tick = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      frame++;
      let alive = false;
      for (const p of parts) {
        p.vy += 0.32; // gravity
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        if (p.y < canvas.height + 30) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - frame / 170);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (alive && frame < 170) raf.current = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [trigger]);

  if (!trigger) return null;
  return <canvas ref={canvasRef} className="pointer-events-none fixed inset-0 z-[9999]" />;
}

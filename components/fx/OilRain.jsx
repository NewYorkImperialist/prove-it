"use client";
import { useEffect, useState } from "react";

// 🛢️ raining down the screen — the payoff for one of the hidden category answers.
export default function OilRain({ trigger }) {
  const [drops, setDrops] = useState([]);

  useEffect(() => {
    if (!trigger) return undefined;
    const batch = Array.from({ length: 44 }, (_, i) => {
      const dur = 2 + Math.random() * 2.6;
      return {
        id: `${trigger}-${i}`,
        left: Math.random() * 100 + "vw",
        size: 22 + Math.random() * 28 + "px",
        animation: `oil-fall ${dur}s linear ${Math.random() * 0.9}s forwards`,
        ttl: (dur + 1.2) * 1000,
      };
    });
    setDrops((d) => [...d, ...batch]);
    const longest = Math.max(...batch.map((b) => b.ttl));
    const t = setTimeout(() => setDrops((d) => d.filter((x) => !x.id.startsWith(`${trigger}-`))), longest);
    return () => clearTimeout(t);
  }, [trigger]);

  return drops.map((d) => (
    <div key={d.id} className="oil-drop" style={{ left: d.left, fontSize: d.size, animation: d.animation }}>
      🛢️
    </div>
  ));
}

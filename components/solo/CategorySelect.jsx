"use client";
import { useMemo } from "react";
import { CATS, nonSprint } from "@/lib/solo-catalog";
import { Select } from "@/components/ui/Field";

// Every category, grouped by genre, with the ones that make poor sprints marked so you know
// what you're choosing.
export default function CategorySelect({ id, value, onChange, className }) {
  const groups = useMemo(() => {
    const by = {};
    for (const c of CATS) (by[c.group] = by[c.group] || []).push(c);
    return Object.entries(by);
  }, []);

  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      {groups.map(([group, cats]) => (
        <optgroup key={group} label={group}>
          {cats.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
              {nonSprint(c) ? " (non-sprint)" : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

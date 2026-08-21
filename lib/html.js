"use strict";
// Shared formatting/escaping helpers for the server's hand-rolled admin HTML pages
// (see routes/admin.js). Pure functions, no shared state.

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// Hour of day (0–23) in US Eastern, DST-aware; falls back to UTC if ICU/tz data is missing.
function easternHour(ts) {
  try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(new Date(ts))) % 24; }
  catch { return new Date(ts).getUTCHours(); }
}
function easternTime(ts) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ts)); }
  catch { return new Date(ts).toISOString().slice(0, 16).replace("T", " "); }
}
function easternFull(ts) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "medium" }).format(new Date(ts)) + " ET"; }
  catch { return new Date(ts).toISOString(); }
}
function easternDay(ts) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts)); }
  catch { return new Date(ts).toISOString().slice(0, 10); }
}
const fmtHour12 = (h) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

function fmtDur(ms) {
  if (ms == null) return "?";
  const s = Math.floor(ms / 1000); if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60); return h + "h " + (m % 60) + "m";
}
function fmtMs(ms) { return ms ? fmtDur(ms) : "—"; }

function bar(n, max) { const w = max ? Math.round((n / max) * 100) : 0; return `<span style="display:inline-block;height:9px;width:${w}%;min-width:${n ? 3 : 0}px;background:#5b8cff;border-radius:2px;vertical-align:middle"></span>`; }
// Wrapped in its own horizontal scroller: these are the admin dashboard's panel tables, and on a
// phone an unwrapped wide table widens the page instead, which drags the headings off-screen with
// it. `.tw` is defined once in routes/admin.js's shared stylesheet.
const tbl = (head, rows, cols) => `<div class="tw"><table><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr>${rows || `<tr><td colspan=${cols}>—</td></tr>`}</table></div>`;

module.exports = { esc, easternHour, easternTime, easternFull, easternDay, fmtHour12, fmtDur, fmtMs, bar, tbl };

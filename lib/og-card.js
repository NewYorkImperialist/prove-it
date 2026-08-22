"use strict";
// What a share card SAYS, and how that gets encoded into an image URL. Pure — no I/O, no DOM, no
// satori — so the copy and (more importantly) the validation are unit-testable without rendering a
// PNG. app/og.png/route.js draws whatever parseCard() hands it, and routes/challenge.js builds the
// <meta property="og:image"> URLs with cardUrl(), so this file is the only place that knows the
// param contract:
//
//   k  kind      one of KINDS ("challenge" | "daily" | "geo" | "room" | "generic")
//   n  name      who is bragging / inviting      (cleanName'd, <= 20 chars)
//   s  score     the number to beat              (integer, 0..9999)
//   c  category  the round/board being named     (<= 48 chars, canonicalised when we know it)
//   b  sub       secondary label (genre, region) (<= 32 chars)
//   r  rounds    how many rounds                 (1..10)
//   t  timer     seconds per round, 0 = "recommended"
//   x  code      multiplayer room code           ([A-Z0-9]{1,4})
//   v  version   SITE.ogCard.v, the cache buster; parseCard ignores it
//
// Those params arrive from whoever pasted the link, not from us: a crawler will happily fetch
// /og.png?k=challenge&n=<anything>. So parseCard is the security boundary for the image route —
// it is total (never throws), clamps every field, and collapses anything it doesn't recognise to
// the generic card rather than drawing attacker-supplied text at 200px.
const SITE = require("./site-config");
const { cleanName } = require("./name-filter.js");
const { ALL_ROUND_NAMES } = require("./category-data.js");
const { MODES, allBoards } = require("./geo-boards.js");

const KINDS = ["challenge", "daily", "geo", "room", "generic"];

const MAX_NAME = 20;      // ~20 fits the headline at a readable size; names are capped at 24 on write
const MAX_CATEGORY = 48;  // "Cities Mistaken for Australia's Capital" is 38, the longest real one
const MAX_SUB = 32;
const MAX_SCORE = 9999;   // the biggest board has 197 answers, so this is already absurdly generous
const MAX_ROUNDS = 10;    // POST /challenge slices the rounds array to 10
const MAX_TIMER = 1800;

// Characters that have no business in a card: C0/C1 controls (a newline would break both the query
// string and the SVG satori builds), the bidi overrides that let a crafted name visually reverse the
// sentence printed around it, and the zero-width family that pads a name past the clamp invisibly.
// Tested by code point rather than matched by a character class, because a regexp literal with
// control characters in it is unreadable and an eslint no-control-regex error besides.
function isUnsafeChar(cp) {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)      // C0 and C1 controls, newlines included
    || cp === 0x61c || (cp >= 0x200b && cp <= 0x200f) // zero-width joiners and the LTR/RTL marks
    || (cp >= 0x202a && cp <= 0x202e)                 // bidi embeddings and overrides
    || (cp >= 0x2066 && cp <= 0x2069)                 // bidi isolates
    || cp === 0xfeff;                                 // byte order mark
}
function stripUnsafe(s) {
  let out = "";
  for (const ch of s) out += isUnsafeChar(ch.codePointAt(0)) ? " " : ch;
  return out;
}

// Slicing by code unit can cut a surrogate pair in half and leave a lone surrogate, which is not
// valid text to hand a font shaper — so clamp by code point.
function clampChars(s, max) {
  const chars = Array.from(s);
  return (chars.length > max ? chars.slice(0, max).join("") : s).trim();
}
function safeText(raw, max) {
  if (raw == null) return "";
  return clampChars(stripUnsafe(String(raw)).replace(/\s+/g, " ").trim(), max);
}

// Blank stays blank (the card just omits the name); anything blocked becomes "Anon", exactly as it
// would on the leaderboard, so a share link can't smuggle a slur into a preview image.
function safeName(raw) {
  const text = safeText(raw, 24);
  return text ? clampChars(cleanName(text), MAX_NAME) : "";
}

// Number("") is 0 and Number(" ") is 0, so an absent param has to be rejected before coercion or
// every card would claim a score of zero.
function safeInt(raw, min, max) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// Same normalisation the client's invite parser uses (hooks/useMultiplayer.js), so a code that
// works in the app works in the card.
function safeCode(raw) {
  return String(raw == null ? "" : raw).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

// Case-insensitive canonical names, so "countries of the world" renders as "Countries of the
// World". Built once: ALL_ROUND_NAMES is ~300 entries and parseCard runs per request.
const CANON_CATEGORY = new Map();
for (const name of ALL_ROUND_NAMES) CANON_CATEGORY.set(name.toLowerCase(), name);
const BOARDS = allBoards();
const BOARD_BY_NAME = new Map(BOARDS.map((b) => [b.name.toLowerCase(), b]));
const MODE_LABEL = new Map(MODES.map((m) => [m.key, m.label]));

// A category that has since been renamed should still render — the alternative is a generic card
// for every link shared before the rename, which is worse than a slightly stale category name.
function safeCategory(raw) {
  const text = safeText(raw, MAX_CATEGORY);
  return text ? (CANON_CATEGORY.get(text.toLowerCase()) || text) : "";
}

// Express gives an array for a repeated param (?n=a&n=b) and URLSearchParams gives the first;
// take the first either way so the two callers can't disagree about what was asked for.
function param(query, key) {
  if (!query) return "";
  if (typeof query.get === "function") return query.get(key) ?? "";
  const v = query[key];
  if (Array.isArray(v)) return v.length ? v[0] : "";
  return v == null ? "" : v;
}

const GENERIC = { kind: "generic", by: "", score: null, category: "", sub: "", rounds: null, timer: null, code: "" };

function parseCard(query) {
  try {
    const raw = param(query, "k");
    const kind = KINDS.includes(raw) ? raw : "generic";
    const card = {
      kind,
      by: safeName(param(query, "n")),
      score: safeInt(param(query, "s"), 0, MAX_SCORE),
      category: safeCategory(param(query, "c")),
      sub: safeText(param(query, "b"), MAX_SUB),
      rounds: safeInt(param(query, "r"), 1, MAX_ROUNDS),
      timer: safeInt(param(query, "t"), 0, MAX_TIMER),
      code: safeCode(param(query, "x")),
    };
    // A geography board is a closed set of 27 known things, so once the name matches we take the
    // answer count and the mode/region label from our own table and throw away whatever the URL
    // claimed. That makes the numeral on a geo card impossible to forge.
    if (kind === "geo") {
      const board = BOARD_BY_NAME.get(card.category.toLowerCase());
      if (board) {
        card.category = board.name;
        card.score = board.answers;
        card.sub = `${MODE_LABEL.get(board.mode) || "Geography"} · ${board.region}`;
      } else {
        card.category = ""; // an unknown board falls back to the generic geography card
        card.score = null;
        card.sub = "";
      }
    }
    // Kinds that are meaningless without their subject: a "challenge" with nobody challenging you,
    // or a room invite with no room, has nothing to draw that the generic card doesn't draw better.
    if ((kind === "challenge" || kind === "daily") && !card.by && card.score == null) return { ...GENERIC };
    if (kind === "room" && !card.code) return { ...GENERIC };
    if (kind === "generic") return { ...GENERIC };
    return card;
  } catch (e) {
    return { ...GENERIC }; // total by construction: a crawler must never get a 500 from a bad param
  }
}

// The canonical form of a parsed card — the image route's in-memory cache key. Derived from the
// PARSED card, not the raw query, so ?k=geo&c=countries+of+the+world and ?k=geo&c=Countries+of+the+World
// are one cache entry instead of two renders of the same picture.
function cardKey(card) {
  return [card.kind, card.by, card.score == null ? "" : card.score, card.category, card.sub,
    card.rounds == null ? "" : card.rounds, card.timer == null ? "" : card.timer, card.code].join("|");
}

// The one sentence the whole feature exists for. Shared with challengePreview() in
// routes/challenge.js so the crawler's <title> and the pixels in the card can't drift apart.
// Category names are plural ("US States"), so a score of 1 can't be dropped straight in front of
// one — it needs a counted noun of its own instead.
function bragLine({ by, score, category }) {
  const who = by || "A friend";
  if (!category || !(score > 0)) return `${who} challenged you on Prove It!`;
  return score === 1
    ? `${who} says you can't name more than 1 answer in ${category}`
    : `${who} says you can't name more than ${score} ${category}`;
}

const roundsPhrase = (n, sub) => `${n} round${n === 1 ? "" : "s"}${sub ? ` of ${sub}` : ""}`;
const timerPhrase = (t) => (t === 0 ? "recommended time per round" : `${t}s per round`);
// The card itself already prints the host in its footer rule, so this line must not repeat it.
const PLAIN_FOOTER = "Free in your browser · no sign-up, just click and play";

// Everything the card renders, per kind. `big` is the focal point (a score, or a room code) and is
// "" when we genuinely don't have a number — the card must not invent one, so app/og.png/route.js
// falls back to a two-line layout instead of drawing a placeholder.
function cardCopy(card) {
  const c = card && card.kind ? card : GENERIC;
  const brag = bragLine(c);
  switch (c.kind) {
    case "challenge":
    case "daily": {
      const daily = c.kind === "daily";
      const hasScore = c.score > 0 && !!c.category;
      return {
        eyebrow: daily ? "Daily challenge" : "Challenge",
        headline: hasScore ? `${c.by || "A friend"} says you can't name more than` : brag,
        big: hasScore ? String(c.score) : "",
        category: hasScore ? c.category : "Name as many as you can before the clock runs out",
        footer: daily
          ? "The same rounds for everyone · a new puzzle every day"
          : [c.rounds ? roundsPhrase(c.rounds, c.sub) : "", c.timer == null ? "" : timerPhrase(c.timer)]
            .filter(Boolean).join(" · ") || PLAIN_FOOTER,
        alt: `Prove It! ${daily ? "daily " : ""}challenge card: ${brag}`,
      };
    }
    case "geo":
      return c.category ? {
        eyebrow: "Geography",
        headline: "Can you name all",
        big: String(c.score),
        category: c.category,
        footer: `${c.sub} · ${BOARDS.length} boards, each with its own leaderboard`,
        alt: `Prove It! geography card: ${c.category} — ${c.score} to find (${c.sub})`,
      } : {
        eyebrow: "Geography",
        headline: "Maps, flags, borders and capitals",
        big: String(BOARDS.length),
        category: "boards, each with its own leaderboard",
        footer: PLAIN_FOOTER,
        alt: `Prove It! geography card: ${BOARDS.length} boards to name`,
      };
    case "room":
      return {
        eyebrow: "Multiplayer",
        headline: c.by ? `${c.by} wants to play you · join room` : "Someone wants to play you · join room",
        big: c.code,
        // Kept under ~40 characters so it stays on one line beside a 4-character room code; the
        // longer version of this line wrapped, which pushed the footer rule off its baseline.
        category: "Name more than them, or call the bluff",
        footer: "Head-to-head in the browser · no sign-up, just the code",
        alt: `Prove It! multiplayer invite: join room ${c.code}`,
      };
    default:
      return {
        eyebrow: "The bluffing word game",
        headline: "Brag how many you can name",
        big: "",
        category: "then back it up against the clock",
        footer: PLAIN_FOOTER,
        alt: SITE.ogImage.alt,
      };
  }
}

// Friendly facts in, short params out. Runs the facts through parseCard first so a URL we build is
// validated by the same code that validates a URL a stranger builds — if the two ever disagreed,
// our own share links would be the ones rendering the generic card.
function cardParams(kind, facts) {
  const f = facts || {};
  const rounds = Array.isArray(f.rounds) ? f.rounds.length : f.rounds;
  const card = parseCard({
    k: kind, n: f.by ?? f.name ?? "", s: f.score ?? "", c: f.category ?? f.board ?? "",
    b: f.sub ?? f.genre ?? "", r: rounds ?? "", t: f.timer ?? "", x: f.code ?? f.room ?? "",
  });
  const p = { k: card.kind };
  if (card.by) p.n = card.by;
  if (card.score != null) p.s = String(card.score);
  if (card.category) p.c = card.category;
  if (card.sub) p.b = card.sub;
  if (card.rounds != null) p.r = String(card.rounds);
  if (card.timer != null) p.t = String(card.timer);
  if (card.code) p.x = card.code;
  // The geo card derives its number and label from the board name, so shipping them in the URL
  // would only make it longer and give a forger something to aim at.
  if (card.kind === "geo") { delete p.s; delete p.b; }
  return p;
}

// Absolute, because a crawler resolves og:image against nothing — a root-relative path is the
// classic way to get a link preview with no picture in it.
function cardUrl(kind, facts) {
  const url = new URL(SITE.ogCard.path.replace(/^\/+/, ""), SITE.url);
  url.searchParams.set("v", String(SITE.ogCard.v));
  for (const [k, v] of Object.entries(cardParams(kind, facts))) url.searchParams.set(k, v);
  return url.toString();
}

// og:image:alt — the text a screen reader gets instead of the card, and what some clients show
// when the image itself fails to load.
const cardAlt = (kind, facts) => cardCopy(parseCard(cardParams(kind, facts))).alt;

module.exports = { KINDS, bragLine, cardParams, parseCard, cardKey, cardCopy, cardUrl, cardAlt };

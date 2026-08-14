"use strict";
// Blocks profanity/slurs in player-supplied display names before they're persisted to a
// leaderboard. Uses `obscenity`'s recommended matcher plus a transformer that skips
// non-alphabetic characters, so spaced-out/punctuated evasion ("n i g g a", "n.i.g.g.e.r")
// is still caught, not just leetspeak. The library's own whitelist keeps innocuous words
// containing slur substrings (e.g. "Scunthorpe", "class") from false-positiving.
const {
  RegExpMatcher, englishDataset, englishRecommendedTransformers, skipNonAlphabeticTransformer,
} = require("obscenity");

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  blacklistMatcherTransformers: [...englishRecommendedTransformers.blacklistMatcherTransformers, skipNonAlphabeticTransformer()],
  whitelistMatcherTransformers: englishRecommendedTransformers.whitelistMatcherTransformers,
});

// True if the (non-empty) name contains profanity/slurs. Blank input is never "blocked" here —
// callers that care about blank names check for that separately.
function isBlocked(raw) {
  const name = String(raw || "").trim();
  return name ? matcher.hasMatch(name) : false;
}

// Returns a safe name: the trimmed input as-is, or "Anon" if it's blank or blocked. This is the
// last-resort server-side backstop (e.g. against direct API calls) — the client is expected to
// call GET /name-check first and refuse to submit a blocked name in the first place.
function cleanName(raw) {
  const name = String(raw || "").trim();
  if (!name) return "Anon";
  return isBlocked(name) ? "Anon" : name;
}

module.exports = { cleanName, isBlocked };

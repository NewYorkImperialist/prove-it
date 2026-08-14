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

// Returns a safe name: the trimmed input as-is, or "Anon" if it contains profanity/slurs.
function cleanName(raw) {
  const name = String(raw || "").trim();
  if (!name) return "Anon";
  return matcher.hasMatch(name) ? "Anon" : name;
}

module.exports = { cleanName };

// Single source of truth for every visitor-facing string that isn't game content:
// page titles, meta/OG/Twitter tags, the credit link, and the server's own tiny HTML
// pages (paused screen, admin dashboard header). Edit values here — app/layout.jsx,
// templates/challenge.html and the server routes all render off this file, so nothing
// needs to be hand-copied across files anymore.
module.exports = {
  siteName: "Prove It!",
  url: "https://proveit.fly.dev/",
  themeColor: "#0c0a07",
  // Bump `v` whenever og-card.png's contents change, so crawlers/clients don't serve a stale cached image.
  // This is the *static* fallback card, still used for the home page and for any share link whose
  // shape we don't recognise. Per-run cards are drawn on demand — see `ogCard` below.
  ogImage: { url: "https://proveit.fly.dev/og-card.png", v: 4, width: 1200, height: 630, alt: "Prove It! — the bluffing word game" },
  // The generated share card (app/og.png/route.js). Same 1.91:1 box every crawler wants, so a
  // generated card and the static one are interchangeable in the meta tags.
  // `v` busts every generated card at once when the drawing changes; the card's own params are
  // already part of its URL, so only a design change needs this bumped.
  ogCard: { path: "/og.png", v: 1, width: 1200, height: 630 },
  credit: { name: "NewYorkImperialist", url: "https://github.com/NewYorkImperialist" },

  // Web app manifest (app/manifest.js) — what the phone shows once the game is installed to the
  // home screen. `background_color` is the splash behind the icon while the app boots, so it
  // matches the page background rather than the accent.
  pwa: {
    name: "Prove It! · the bluffing word game",
    shortName: "Prove It!",
    description: "Brag how many you can name, then back it up against the clock. Free, no sign-up.",
    backgroundColor: "#0c0a07",
  },

  // The app itself · app/layout.jsx feeds these to Next's `metadata` export (there's no
  // index.html any more — the vanilla one lives in archive/ and isn't served).
  home: {
    title: "Prove It!",
    description: "A fast, free browser bluffing word game · name as many as you can, or call your opponent's bluff. No sign-up; just click and play.",
    ogTitle: "Prove It! · the bluffing word game",
    ogDescription: "Brag how many you can name, then back it up against the clock. Play free in your browser · solo against the clock, or head-to-head with friends.",
    twitterDescription: "Brag how many you can name, then back it up against the clock. Free, no sign-up.",
  },

  // templates/challenge.html — share-link stub, the one page still rendered from a template.
  // routes/challenge.js overrides og/title per ?id= with the challenger's name + score-to-beat
  // when it can, and falls back to these defaults.
  challenge: {
    title: "Prove It! · Challenge",
    description: "A friend challenged you on Prove It! · name as many as you can across the rounds, then climb the leaderboard.",
    ogTitle: "⚡ Beat my Prove It! challenge",
    ogDescription: "Multi-round naming challenge. No sign-up · just click and play, then see who tops the leaderboard.",
  },

  // Served instead of the app when the cost guard trips (lib/cost-guard.js's BUDGET_PAGE).
  paused: {
    title: "Prove It! — paused",
    emoji: "🎯💤",
    heading: "Prove It! is resting",
    body: "We hit this month's budget, so the game is paused to keep costs in check. It comes back automatically at the start of next month — thanks for playing!",
  },

  // Owner-only /admin dashboard header (routes/admin.js).
  adminDashboard: {
    title: "Prove It! — server",
    heading: "🎯 Prove It! — live server",
  },
};

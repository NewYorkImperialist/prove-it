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

  // Owner-only /admin dashboard (routes/admin.js). The dashboard is Express-rendered HTML rather
  // than part of the Next app, so unlike the game it gets no manifest for free — routes/admin.js
  // serves its own at /admin/manifest.webmanifest, and `pwaAdmin` below is what goes in it.
  adminDashboard: {
    title: "Prove It! Admin",
    heading: "Prove It! Admin",
    // Its own palette, kept apart from the game's amber on purpose: a glance at the screen should
    // say which of the two apps you are looking at. The stripe on the admin icon is this blue.
    themeColor: "#0e1016",
    accent: "#5b8cff",
  },

  // The dashboard installs as its own app, separate from the game, so the two live side by side on
  // a home screen without one shadowing the other.
  //
  // `start_url` has to carry the owner key: every /admin route is gated on it (lib/owner-auth.js),
  // so a start_url without it would launch the installed app straight into a 404. That does mean
  // the key ends up inside the installed manifest on the owner's own device — which is why the
  // route that serves it is itself owner-gated and answers `private, no-store`. It is no wider an
  // exposure than the URL already sitting in that browser's history and bookmarks, but it is the
  // reason this manifest is not a static file in public/.
  pwaAdmin: {
    name: "Prove It! Admin",
    shortName: "PI Admin",
    description: "Live server dashboard for Prove It! — rooms, players, cost and traffic.",
    backgroundColor: "#0e1016",
  },
};

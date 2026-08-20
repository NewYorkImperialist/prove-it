import SITE from "@/lib/site-config";

// Next serves this at /manifest.webmanifest and injects the <link rel="manifest"> into every page
// itself, so there's no file in public/ and no tag to keep in sync by hand. Strings come from
// site-config.js like every other visitor-facing string in the app.
//
// What this buys: the game becomes installable to a home screen, and launched from there it opens
// without browser chrome — the difference between a bookmark and something that feels like an app,
// which matters for a game people come back to daily.
//
// Asking the player to install is deliberately left to the browser. Chrome decides when to offer
// its own prompt from its engagement heuristics, and iOS never offers one at all — Add to Home
// Screen is manual there, by Apple's design. A custom in-app prompt converts better but is real
// UI on the tightest screen this app has, so it's a separate decision for later.
export default function manifest() {
  return {
    name: SITE.pwa.name,
    short_name: SITE.pwa.shortName,
    description: SITE.pwa.description,
    start_url: "/",
    display: "standalone",
    // background_color is the splash behind the icon while the app boots, so it matches the page
    // background rather than the accent; theme_color tints the system bars once it's running.
    background_color: SITE.pwa.backgroundColor,
    theme_color: SITE.themeColor,
    // Both orientations are real supported layouts here — 844x390 landscape is one of the three
    // viewports the browser tests run at — so don't let the manifest lock the game to portrait.
    orientation: "any",
    categories: ["games", "entertainment", "education"],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Android won't offer the install prompt without a 512 maskable, and a maskable icon has to
      // bleed to the edges: the launcher crops it to whatever shape the OS uses, so the plate's
      // transparent margin would show up as a gap. scripts/make-icons.js draws that variant
      // full-bleed with the mark inside the safe circle.
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      // Android 13+ themed icons: the launcher recolours every tile to match the wallpaper, using
      // this layer purely as an alpha mask. Without it the amber plate stays amber on a themed
      // home screen and the game is the one tile ignoring the user's setting.
      { src: "/icon-monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" },
    ],
  };
}

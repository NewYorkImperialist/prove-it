import SITE from "@/lib/site-config";
import { ownerKeyFrom } from "../guard";

export const dynamic = "force-dynamic";

// The admin installs as its own app, separate from the game. Two identical tiles on a home screen
// would be unusable, which is what the dev-striped icon set and the separate `id` are for.
export function GET(request) {
  const key = ownerKeyFrom(request);
  // 404 rather than 401, matching every other admin route: an unauthenticated visitor should not be
  // able to learn this path exists.
  if (key === null) return new Response("Not found", { status: 404 });

  const DASH = SITE.adminDashboard;
  const body = JSON.stringify({
    id: "/admin",
    name: SITE.pwaAdmin.name,
    short_name: SITE.pwaAdmin.shortName,
    description: SITE.pwaAdmin.description,
    // Every /admin route is gated on the key, so an installed app whose start_url lacked it would
    // launch straight into a 404.
    start_url: `/admin?key=${encodeURIComponent(key)}`,
    scope: "/admin",
    display: "standalone",
    background_color: SITE.pwaAdmin.backgroundColor,
    theme_color: DASH.themeColor,
    orientation: "any",
    icons: [
      { src: "/admin-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/admin-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/admin-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/admin-icon-monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" },
    ],
  });
  return new Response(body, {
    headers: {
      "content-type": "application/manifest+json",
      // start_url embeds the owner key, so this must never land in a shared cache.
      "cache-control": "private, no-store",
    },
  });
}

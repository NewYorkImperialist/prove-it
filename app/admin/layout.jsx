import SITE from "@/lib/site-config";
import "./admin.css";

const DASH = SITE.adminDashboard;

// Every /admin page is dynamic, and this is load-bearing rather than a precaution.
//
// These pages report live server state — who is connected right now, which rooms exist, whether the
// cost guard has tripped. Next's default is to prerender what it can at build time, which for a page
// reading globalThis at module scope would mean baking in "0 rooms, 0 online" once, at deploy, and
// serving that snapshot forever. Worse, it would try to render them during `next build`, where
// server/index.js has never run and the live-state bridge does not exist.
//
// Reading searchParams (every page needs ?key=) already forces dynamic rendering, so this is
// belt-and-braces — but the failure it prevents is a dashboard that looks fine and is stale, which
// is the one kind of wrong this surface must never be.
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Overrides the game's metadata for this subtree: its own title, its own near-black theme colour,
// its own manifest and icons. The admin installs as a SEPARATE app from the game — two identical
// tiles on a home screen would be unusable — which is what the dev-striped icon set is for.
//
// `icons.icon` matters more than it looks: the Express pages declared no favicon at all for most of
// their life, so a browser fell back to /favicon.ico (a 404) and showed whatever it had cached.
export const metadata = {
  title: DASH.title,
  robots: { index: false, follow: false }, // nothing here should ever be in an index
  manifest: "/admin/manifest.webmanifest",
  icons: { icon: "/admin-icon-192.png", apple: "/admin-apple-icon.png" },
  appleWebApp: { capable: true, title: SITE.pwaAdmin.shortName, statusBarStyle: "black" },
};

export const viewport = {
  themeColor: DASH.themeColor,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// `.adm` is the page. The Express version styled <body>, which it owned; here the game's root layout
// owns <html>/<body> and app/globals.css, so the wrapper carries the background, the full-height
// fill and the safe-area padding instead. See app/admin/admin.css.
export default function AdminLayout({ children }) {
  return <div className="adm">{children}</div>;
}

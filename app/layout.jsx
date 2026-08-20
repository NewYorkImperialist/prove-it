import Script from "next/script";
import { Inter, Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import SITE from "@/lib/site-config";
import { FAVICON } from "@/lib/favicon";
import "./globals.css";

// The three faces the vanilla build pulled from Google Fonts by <link>; next/font
// self-hosts them and hands us the CSS variables app/globals.css maps into @theme.
const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--font-inter", display: "swap" });
const grotesk = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display-grotesk", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-mono", display: "swap" });

// Every visitor-facing string still comes from site-config.js — the single source of
// truth the server, the challenge share-stub and this page all render from.
export const metadata = {
  title: SITE.home.title,
  description: SITE.home.description,
  icons: { icon: FAVICON },
  openGraph: {
    type: "website",
    siteName: SITE.siteName,
    title: SITE.home.ogTitle,
    description: SITE.home.ogDescription,
    url: SITE.url,
    images: [{ url: `${SITE.ogImage.url}?v=${SITE.ogImage.v}`, width: SITE.ogImage.width, height: SITE.ogImage.height }],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE.home.ogTitle,
    description: SITE.home.twitterDescription,
    images: [`${SITE.ogImage.url}?v=${SITE.ogImage.v}`],
  },
};

export const viewport = { themeColor: SITE.themeColor, width: "device-width", initialScale: 1 };

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable} ${plexMono.variable}`}>
      <body>
        {children}
        {/* Cloudflare Web Analytics */}
        <Script
          strategy="afterInteractive"
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "0ed8f939fd634facb985fc4f718f09cd"}'
        />
      </body>
    </html>
  );
}

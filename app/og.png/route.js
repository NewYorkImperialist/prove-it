import { ImageResponse } from "next/og";
import SITE from "@/lib/site-config";
import { parseCard, cardKey, cardCopy } from "@/lib/og-card";

// The generated Open Graph card: /og.png?k=challenge&n=Jayden&s=12&c=US+States renders the
// "JAYDEN SAYS YOU CAN'T NAME MORE THAN 12 US STATES" picture Discord/iMessage/Twitter put in the
// chat. lib/og-card.js owns the param contract and the copy; this file only draws.
//
// The segment is literally named "og.png" so the URL ends in an image extension — the same idiom as
// app/rss.xml/route.ts. Crawlers are the fussiest clients we have and an extensionless /og is the
// kind of thing one of them silently declines to fetch.
//
// Renderer: next/og re-exports @vercel/og, which Next already ships compiled (satori + resvg-wasm +
// a bundled Geist-Regular.ttf). Nothing to add to package.json, and no fontconfig or system fonts
// to install into the Alpine image. The catch is that ONLY the 400 weight is bundled, so there is
// no bold available at all: every bit of hierarchy below comes from size, colour and letter-spacing.
// For the same reason there is no emoji font — satori would need a network image loader for those —
// so the ◎ badge is drawn as three nested rounded divs rather than typed as a character.

export const runtime = "nodejs"; // resvg/yoga load their .wasm off disk, and the edge build can't
export const dynamic = "force-dynamic"; // the whole point is a different picture per query string

const BG = "#0c0a07";       // site background
const AMBER = "#f5a623";    // brand accent
const INK = "#f7f3ec";      // primary text on the near-black field
const MID = "#b8ac9a";      // the setup line above the number
const MUTED = "#7d7365";    // footer / eyebrow

const HOST = SITE.url.replace(/^https?:\/\//, "").replace(/\/$/, "");

// Rendered cards are immutable for a given query string, so re-drawing one is pure waste — and
// waste that shows up on the bill twice, since server/index.js's egress middleware tallies every
// byte we send into the admin cost projection. A crawler refetch, a Discord re-embed and every
// person who opens the same group chat all land on the same key.
//
// Bounded on purpose: the key space is attacker-controlled (any ?n= produces a new one), so an
// unbounded Map here would be a slow memory leak anyone could drive. 64 entries is far more than
// the handful of links in flight at once, and eviction is least-recently-used via re-insertion.
const CACHE_MAX = 64;
const CARDS = new Map();
function cachedCard(key) {
  const png = CARDS.get(key);
  if (png) { CARDS.delete(key); CARDS.set(key, png); } // touch: move to the newest end
  return png;
}
function rememberCard(key, png) {
  CARDS.set(key, png);
  while (CARDS.size > CACHE_MAX) CARDS.delete(CARDS.keys().next().value);
}

// ?v= (SITE.ogCard.v) is the cache buster, so the card at a given URL never changes and can be
// cached hard by every proxy between us and the reader.
const PNG_HEADERS = { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" };

// Satori has no text-wrapping metrics we can query and no `clamp()`, so long strings are fitted by
// stepping the font size down against character count. Every value below is chosen so the widest
// string the validator will let through (a 48-char category, a 20-char name) still fits the 1072px
// of usable width.
function headlineSize(text) {
  if (text.length <= 34) return 42;
  if (text.length <= 48) return 34;
  return 28;
}
function subjectSize(text) {
  if (text.length <= 16) return 78;
  if (text.length <= 24) return 66;
  if (text.length <= 34) return 54;
  if (text.length <= 44) return 44;
  return 38;
}

// The ◎ badge from lib/favicon.js as geometry instead of a glyph.
function Mark() {
  return (
    <div style={{ width: 54, height: 54, borderRadius: 17, background: AMBER, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 25, height: 25, borderRadius: 13, background: BG, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 10, height: 10, borderRadius: 5, background: AMBER }} />
      </div>
    </div>
  );
}

// One layout, fed by cardCopy(): an eyebrow that names the kind, a setup line, the focal point
// (a score, or a room code), the subject being named, and a footer of context. `big` is empty when
// we have no real number to show — inventing one would be a lie about someone's score — and that
// branch promotes the setup line to headline size instead of leaving a hole.
function Card({ copy }) {
  const big = copy.big;
  return (
    <div style={{ width: SITE.ogCard.width, height: SITE.ogCard.height, display: "flex", flexDirection: "column", background: BG, fontFamily: "geist", color: INK }}>
      <div style={{ display: "flex", height: 10, background: AMBER }} />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "44px 64px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <Mark />
            <div style={{ display: "flex", marginLeft: 20, fontSize: 30, letterSpacing: 7, color: INK }}>PROVE IT!</div>
          </div>
          <div style={{ display: "flex", fontSize: 22, letterSpacing: 4, color: MUTED }}>{copy.eyebrow.toUpperCase()}</div>
        </div>

        {big ? (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", maxWidth: 1072, fontSize: headlineSize(copy.headline), letterSpacing: 2, color: MID }}>
              {copy.headline.toUpperCase()}
            </div>
            <div style={{ display: "flex", alignItems: "flex-end", marginTop: 4 }}>
              <div style={{ display: "flex", fontSize: big.length > 3 ? 150 : 186, lineHeight: 1, letterSpacing: big.length > 3 ? 6 : -6, color: AMBER }}>
                {big}
              </div>
            </div>
            <div style={{ display: "flex", maxWidth: 1072, marginTop: 10, fontSize: subjectSize(copy.category), letterSpacing: 1, color: INK }}>
              {copy.category.toUpperCase()}
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", maxWidth: 1000, fontSize: subjectSize(copy.headline), lineHeight: 1.15, letterSpacing: 1, color: INK }}>
              {copy.headline.toUpperCase()}
            </div>
            <div style={{ display: "flex", maxWidth: 1000, marginTop: 18, fontSize: 36, letterSpacing: 1, color: AMBER }}>
              {copy.category.toUpperCase()}
            </div>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 24, color: MUTED }}>
          <div style={{ display: "flex" }}>{copy.footer}</div>
          <div style={{ display: "flex", color: AMBER }}>{HOST}</div>
        </div>
      </div>
    </div>
  );
}

export async function GET(request) {
  // Everything past this line is validated and clamped: parseCard collapses anything it doesn't
  // recognise to the generic card, so no part of the query string reaches the canvas verbatim.
  const card = parseCard(request.nextUrl.searchParams);
  const key = cardKey(card);

  const hit = cachedCard(key);
  if (hit) return new Response(hit, { headers: PNG_HEADERS });

  try {
    // ImageResponse streams, so satori/resvg failures surface when the body is drained rather than
    // at construction — which is why the await, not just the constructor, is inside the try.
    const res = new ImageResponse(<Card copy={cardCopy(card)} />, { width: SITE.ogCard.width, height: SITE.ogCard.height });
    const png = new Uint8Array(await res.arrayBuffer());
    rememberCard(key, png);
    return new Response(png, { headers: PNG_HEADERS });
  } catch (e) {
    // A crawler that gets a 500 here caches "this link has no image" for far longer than it would
    // take us to fix the bug, so fall back to the hand-made static card on the same host. Not
    // cached: whatever broke is probably temporary, and we want the next fetch to try again.
    // Same-host, so this works on localhost and on a preview deploy too, not just on the domain
    // site-config.js names.
    const fallback = new URL(`${new URL(SITE.ogImage.url).pathname}?v=${SITE.ogImage.v}`, request.url);
    return new Response(null, { status: 302, headers: { location: fallback.toString(), "cache-control": "no-store" } });
  }
}

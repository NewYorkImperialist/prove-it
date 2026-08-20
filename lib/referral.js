"use strict";
// Referral-source labelling: one messy `document.referrer` + the URL the visitor landed on, in;
// one short canonical channel label ("reddit", "search", "direct"), out. The point is the owner's
// dashboard question — "which channels actually deliver players" — which a raw referrer column
// can't answer, because the same channel arrives as old.reddit.com, www.reddit.com, redd.it and
// out.reddit.com, and because a link shared on X arrives as t.co.
//
// Deliberately channel-level only: a host and a campaign tag, nothing per-person. The anonymous
// pi_visitor id already handles "is this the same browser as last time"; nothing here adds to it.
//
// Pure, CommonJS, no I/O — the client bundle can import it too (see components/SocketProvider.jsx,
// which chose to send raw values and let the SERVER label them, so improving this file doesn't
// require shipping a new bundle). Every function is total: a malformed URL, a 4KB referrer or a
// string full of control characters must produce a short safe label, never an exception, because
// this runs inside the analytics path of a socket handler where a throw would cost a connection.

// Hard limits. The label reaches SQL as a bound parameter and HTML as escaped output, so neither
// is a safety boundary we depend on — it's kept clean and short here, at the source, so a
// dashboard table stays readable and a hostile referrer can't bloat every session row.
const MAX_LABEL = 32;
const MAX_REFERRER = 200;

// Control characters have no business in either value and would corrupt log lines / HTML.
// Done as a code-point filter rather than the obvious /[\u0000-\u001f]/ character class, which trips
// eslint's no-control-regex — a rule worth leaving switched on repo-wide, since a control character
// inside a regex is nearly always a typo rather than, as here, the entire intent.
function strip(raw) {
  let out = "";
  for (const ch of String(raw == null ? "" : raw)) { const c = ch.codePointAt(0); if (c > 31 && c !== 127) out += ch; }
  return out.trim();
}

// Exact-host matches, checked BEFORE the suffix list: these would otherwise be swallowed by a
// broader rule (mail.google.com and gemini.google.com both end in .google.com, but neither is a
// search referral — one is someone clicking a link in Gmail, the other an AI answer).
const EXACT = {
  "mail.google.com": "email",
  "mail.yahoo.com": "email",
  "outlook.live.com": "email",
  "outlook.office.com": "email",
  "gemini.google.com": "ai-chat",
};

// host → channel. A match is the host itself or any subdomain of it, which is what folds
// www./m./old./l./out. variants together without listing each one.
const SUFFIX = [
  ["reddit.com", "reddit"], ["redd.it", "reddit"], ["reddit.app.link", "reddit"],
  ["discord.com", "discord"], ["discord.gg", "discord"], ["discordapp.com", "discord"],
  // x.com, twitter.com and the t.co link wrapper are one channel: the owner wants to know a post
  // there worked, not which of the brand's three domains the click came through.
  ["x.com", "twitter"], ["twitter.com", "twitter"], ["t.co", "twitter"],
  ["facebook.com", "facebook"], ["fb.com", "facebook"], ["fb.me", "facebook"], ["fb.watch", "facebook"],
  ["instagram.com", "instagram"],
  ["tiktok.com", "tiktok"],
  ["youtube.com", "youtube"], ["youtu.be", "youtube"],
  ["news.ycombinator.com", "hackernews"],
  ["linkedin.com", "linkedin"], ["lnkd.in", "linkedin"],
  ["whatsapp.com", "whatsapp"], ["wa.me", "whatsapp"],
  ["t.me", "telegram"], ["telegram.me", "telegram"], ["telegram.org", "telegram"],
  ["bsky.app", "bluesky"],
  ["pinterest.com", "pinterest"], ["pin.it", "pinterest"],
  ["snapchat.com", "snapchat"],
  ["twitch.tv", "twitch"],
  ["github.com", "github"],
  ["substack.com", "substack"],
  // Chat assistants are a real referral channel now and read very differently from a search hit:
  // "an AI recommended the site" vs "someone searched for it".
  ["chatgpt.com", "ai-chat"], ["chat.openai.com", "ai-chat"], ["claude.ai", "ai-chat"], ["perplexity.ai", "ai-chat"],
  // Search engines all collapse to one bucket — the interesting fact is "found us by searching",
  // and splitting three Bing hits off from four DuckDuckGo hits tells the owner nothing.
  ["bing.com", "search"], ["duckduckgo.com", "search"], ["search.yahoo.com", "search"], ["yandex.ru", "search"],
  ["baidu.com", "search"], ["ecosia.org", "search"], ["startpage.com", "search"], ["search.brave.com", "search"],
];

const under = (host, base) => host === base || host.endsWith("." + base);
// Google has ~190 country domains (google.com, google.co.uk, google.com.br …); a suffix list would
// never be complete, so it gets a pattern instead.
const isGoogleSearch = (host) => /(^|\.)google(\.[a-z]{2,3})+$/.test(host);

function channelFor(host) {
  if (EXACT[host]) return EXACT[host];
  if (isGoogleSearch(host)) return "search";
  for (const [base, channel] of SUFFIX) if (under(host, base)) return channel;
  return null;
}

// A campaign tag is owner-supplied but arrives through a URL a stranger can type, so it's
// slugified rather than trusted: lowercase, only [a-z0-9._-], no runs of separators, clamped.
function slug(raw) {
  return strip(raw).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, MAX_LABEL);
}

// The landing value may be an absolute URL (location.href) OR just a query string ("?utm_source=x"),
// because the client is allowed to send only location.search — hence the base. The base host is a
// name that can never resolve, so a relative landing value can never look same-origin (below).
function parseLanding(raw) {
  const s = strip(raw);
  if (!s) return null;
  try { return new URL(s, "https://landing.invalid/"); } catch { return null; }
}

// A referrer, by contrast, is parsed STRICTLY with no base: browsers only ever send absolute URLs,
// so anything relative is garbage and must fall through to "direct" rather than be resolved against
// the base and mistaken for a real host.
function parseAbs(raw) {
  const s = strip(raw);
  if (!s) return null;
  try { return new URL(s); } catch { return null; }
}

// Bare hostname, comparable: lowercased, "www." dropped (the only prefix that is never meaningful).
const hostOf = (u) => (u && u.hostname ? u.hostname.toLowerCase().replace(/^www\./, "") : "");

// The raw referrer, kept alongside the label: it's the one thing that can't be reconstructed later
// if channelFor() turns out to have mislabelled or missed a host.
function safeReferrer(raw) {
  const s = strip(raw);
  return s ? s.slice(0, MAX_REFERRER) : null;
}

/**
 * The channel a visit came from.
 *
 * @param referrer  raw `document.referrer` ("" for a direct hit — that's what browsers send).
 * @param landing   the URL the visitor first landed on, before the app rewrote it. Absolute
 *                  (location.href) or a bare query string; only its campaign params and its host
 *                  are read, and it is never persisted — a stray secret in a query string must not
 *                  end up in the sessions table.
 * @param self      optional own host/origin for the same-origin check; defaults to the landing
 *                  host, which is already us whenever the client sent an absolute URL.
 * @returns a short label: "direct" when there's nothing to attribute.
 */
function sourceOf({ referrer, landing, self } = {}) {
  const land = parseLanding(landing);

  // An explicit campaign tag wins over the referrer header, always: it's the deliberate signal
  // ("I posted THIS link in THAT Discord"), while the header is whatever the browser felt like
  // sending — and is empty entirely for the shares that matter most (chat apps, email clients,
  // anything with a referrer policy).
  if (land) {
    for (const key of ["utm_source", "ref", "src"]) { // precedence: the most standard name first
      const tagged = slug(land.searchParams.get(key));
      if (tagged) return tagged;
    }
  }

  const host = hostOf(parseAbs(referrer));
  // No referrer, or one so malformed it won't parse: nothing to attribute, so it's a direct hit.
  // (A garbage referrer is vanishingly rare and indistinguishable from none for our purposes.)
  if (!host) return "direct";

  // Same-origin referrers are internal navigation, NOT a referral, and they're common here: the
  // app rewrites its own URL with history.replaceState in several places (adding/stripping ?id=,
  // ?crown=), so a reload or an in-app navigation arrives carrying our own URL as its referrer.
  // They're folded into "direct"
  // rather than a separate "internal" bucket: by the time a visitor is navigating inside the
  // site we've already lost how they arrived, which is exactly what "direct" means here — and
  // an un-collapsed self-referral would show up as the site's own domain out-ranking every real
  // channel in the table.
  // `self` accepts a bare host ("prove-it.fly.dev") as well as a full origin, since the server has
  // the former to hand from the request headers; with neither, the landing URL's own host is us.
  const own = strip(self);
  const ownHost = own ? hostOf(parseAbs(/^[a-z][a-z0-9+.-]*:\/\//i.test(own) ? own : "https://" + own)) : hostOf(land);
  if (ownHost && ownHost !== "landing.invalid" && host === ownHost) return "direct";

  // A host we know gets its canonical channel; anything else keeps its hostname, so a channel
  // nobody hardcoded (a forum, a newsletter, an aggregator) still shows up by name and can be
  // promoted into SUFFIX later. Native app referrers land here too — Android sends them as
  // "android-app://com.reddit.frontpage/", which reads fine as a row in the table.
  return channelFor(host) || slug(host) || "direct";
}

module.exports = { sourceOf, safeReferrer, MAX_LABEL, MAX_REFERRER };

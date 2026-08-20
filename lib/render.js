"use strict";
// Fill {{TOKEN}} placeholders in an HTML template from a flat vars object (see site-config.js
// for the values). Used by the challenge share-link stub (templates/challenge.html) and the
// server's own small pages; the app itself renders its head through app/layout.jsx off the
// same site-config.js.
const SITE = require("./site-config");
const { FAVICON } = require("./favicon.js");

function render(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

// Every token a template can use needs a default here, even the ones a route almost always
// overrides: render() leaves an unknown token as the literal "{{TOKEN}}", so a missing default
// doesn't fail loudly — it ships a meta tag with braces in it straight to a crawler.
const siteVars = { // fields shared across every templated page
  FAVICON,
  OG_SITE_NAME: SITE.siteName,
  OG_URL: SITE.url,
  // The static hand-made card is the site-wide default; routes/challenge.js swaps in a generated
  // one (app/og.png/route.js) for share links whose shape it recognises. Both are the same
  // 1200x630 box, so the width/height tags below hold either way.
  OG_IMAGE: `${SITE.ogImage.url}?v=${SITE.ogImage.v}`,
  OG_IMAGE_WIDTH: SITE.ogImage.width,
  OG_IMAGE_HEIGHT: SITE.ogImage.height,
  OG_IMAGE_ALT: SITE.ogImage.alt,
  TWITTER_TITLE: SITE.home.ogTitle,
  TWITTER_DESCRIPTION: SITE.home.twitterDescription,
  THEME_COLOR: SITE.themeColor,
  CREDIT_NAME: SITE.credit.name,
  CREDIT_URL: SITE.credit.url,
};

module.exports = { render, siteVars };

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

const siteVars = { // fields shared across every templated page
  FAVICON,
  OG_SITE_NAME: SITE.siteName,
  OG_URL: SITE.url,
  OG_IMAGE: `${SITE.ogImage.url}?v=${SITE.ogImage.v}`,
  OG_IMAGE_WIDTH: SITE.ogImage.width,
  OG_IMAGE_HEIGHT: SITE.ogImage.height,
  THEME_COLOR: SITE.themeColor,
  CREDIT_NAME: SITE.credit.name,
  CREDIT_URL: SITE.credit.url,
};

module.exports = { render, siteVars };

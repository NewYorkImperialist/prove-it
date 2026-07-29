"use strict";
// Fill {{TOKEN}} placeholders in an HTML template from a flat vars object (see site-config.js
// for the values). Shared by index.html and challenge.html so meta tags/titles/credit link
// live in exactly one place.
const SITE = require("../site-config");

function render(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

const siteVars = { // fields shared across every templated page
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

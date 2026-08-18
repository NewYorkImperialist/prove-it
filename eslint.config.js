"use strict";
const js = require("@eslint/js");
const globals = require("globals");

// server.js and friends run under Node (CommonJS); public/app.js, public/geomap.js,
// public/capitals.js, public/categories.js are loaded straight into the browser via <script>
// tags (no bundler, no modules) — see public/index.html.
module.exports = [
  js.configs.recommended,
  {
    ignores: ["archive/**", "node_modules/**"],
  },
  {
    files: ["server.js", "game-engine.js", "race-engine.js", "matchmaking.js", "stats.js", "site-config.js", "eslint.config.js", "rooms.js", "lib/**/*.js", "routes/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    // Plain (non-module) <script>-loaded browser files — index.html loads
    // categories.js/capitals.js/geomap.js/app.js in that order, so top-level
    // bindings from one are visible as globals in the next.
    files: ["public/app.js", "public/geomap.js", "public/capitals.js", "public/categories.js"],
    languageOptions: {
      sourceType: "script",
      globals: globals.browser,
    },
  },
  {
    // categories.js is dual-mode: also `require()`d by game-engine.js under
    // Node — see its trailing module.exports guard.
    files: ["public/categories.js"],
    languageOptions: { globals: { module: "readonly" } },
  },
  {
    files: ["public/app.js"],
    languageOptions: {
      globals: {
        io: "readonly", // socket.io.js (loaded from /socket.io/socket.io.js)
        CATEGORY_GROUPS: "readonly", // from categories.js
        GeoMap: "readonly", // from geomap.js
      },
    },
  },
  {
    files: ["test/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];

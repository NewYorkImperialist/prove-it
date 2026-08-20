"use strict";
const js = require("@eslint/js");
const globals = require("globals");
const jsxPlugin = require("./tools/eslint-jsx.js");

// Three worlds in one repo:
//   • the Node server (CommonJS): server/, lib/, routes/, data/
//   • the Next.js client (ES modules + JSX): app/, components/, hooks/, lib/browser/
//   • the tests (CommonJS, node:test)
// lib/ is deliberately CommonJS even where the client imports it — those modules are shared
// with the server and covered by node:test, and the bundler handles CJS imports fine.
module.exports = [
  js.configs.recommended,
  {
    ignores: ["archive/**", "node_modules/**", ".next/**"],
  },
  {
    files: [
      "server/**/*.js", "eslint.config.js", "next.config.js", "lib/**/*.js", "routes/**/*.js", "data/**/*.js", "tools/**/*.js",
    ],
    ignores: ["lib/browser/**"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
  },
  {
    // The browser half of lib/: ES modules that touch window/document (sound, storage, the
    // geography board), imported only from client components.
    files: ["lib/browser/**/*.js"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      globals: globals.browser,
    },
  },
  {
    // React components and hooks. ESLint's own parser handles JSX with this flag on; the local
    // jsx-uses-vars rule is what keeps no-unused-vars from flagging every component import.
    files: ["app/**/*.{js,jsx}", "components/**/*.{js,jsx}", "hooks/**/*.{js,jsx}"],
    plugins: { jsx: jsxPlugin },
    languageOptions: {
      sourceType: "module",
      ecmaVersion: "latest",
      parserOptions: { ecmaFeatures: { jsx: true } },
      // process is a build-time read here, not a browser global: Next inlines NEXT_PUBLIC_* into
      // the bundle, so `process.env.NEXT_PUBLIC_…` never survives to the client. Declaring it once
      // beats an inline /* global process */ in every file that reads one.
      globals: { ...globals.browser, process: "readonly" },
    },
    rules: {
      "jsx/jsx-uses-vars": "error",
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
    // Playwright specs run in Node, but page.evaluate() callbacks are serialised and executed
    // inside the browser, so both sets of globals are legitimately in scope in one file.
    files: ["test-browser/**/*.js", "playwright.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];

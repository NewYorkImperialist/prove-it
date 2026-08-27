"use strict";
/** @type {import('next').NextConfig} */
// The app runs behind a custom server (server/index.js) that owns Socket.IO and the Express API
// routes, then hands everything else to Next's request handler — so there are no rewrites
// or redirects here; ordering lives in server/index.js.
module.exports = {
  reactStrictMode: true,
  // server/index.js calls app.disable("x-powered-by"), but that only covers responses Express
  // writes. Everything Next renders — which is the entire game — still announced the framework and
  // its presence in the stack to any scanner. Nothing gains from that.
  poweredByHeader: false,
  // categories.js / capitals.js are plain CommonJS data modules shared with the Node server.
  outputFileTracingIncludes: { "/": ["./data/**"] },
};

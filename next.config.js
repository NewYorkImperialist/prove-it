"use strict";
/** @type {import('next').NextConfig} */
// The app runs behind a custom server (server.js) that owns Socket.IO and the Express API
// routes, then hands everything else to Next's request handler — so there are no rewrites
// or redirects here; ordering lives in server.js.
module.exports = {
  reactStrictMode: true,
  // categories.js / capitals.js are plain CommonJS data modules shared with the Node server.
  outputFileTracingIncludes: { "/": ["./data/**"] },
};

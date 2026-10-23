// Startup file for cPanel "Setup Node.js App" (Phusion Passenger), which loads CommonJS.
// The server itself is an ES module bundle in dist/index.js.
process.env.NODE_ENV ??= "production";
// This package's dashboard is built for the username/password login.
process.env.AUTH_MODE ??= "local";

import("./dist/index.js").catch((error) => {
  console.error("[Startup] Failed to start Sepand Inbox:", error);
  process.exit(1);
});

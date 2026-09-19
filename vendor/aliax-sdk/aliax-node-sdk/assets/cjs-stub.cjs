// CommonJS guard stub. The Aliax SDK is ESM-only; this file exists so a
// `require('aliax')` from a CJS project throws an actionable message
// instead of the opaque `ERR_REQUIRE_ESM` Node would otherwise produce.
//
// To use Aliax from CommonJS:
//   const { Aliax } = await import('aliax');
// Or migrate the calling module to ESM (set "type": "module" in your
// package.json, rename to .mjs, or use a bundler with ESM output).
"use strict";
throw new Error(
  "aliax is ESM-only. Use `await import('aliax')` from CommonJS, " +
    "or migrate the calling module to ESM. " +
    "See https://nodejs.org/api/esm.html and https://aliax.xyz/docs."
);

# Changelog

All notable changes to the `aliax` Node SDK.

## 1.0.3 — Encrypted mapper release

Ships the encrypted `dom-mapper.dat` artifact, authenticated mapper sessions,
single-use execution tickets, and telemetry-backed ticket renewal.

## 1.0.2 — First published Node release

Version-number bump only. Identical code to the 1.0.0 audit pass; published
as `1.0.2` because the `aliax` name on npm has the `1.0.0` and `1.0.1`
slots permanently burned by npm's immutability policy (the previous owner
unpublished those versions in Dec 2025, and unpublished version numbers
can never be reclaimed). Behavioral parity with `aliax` Python `1.0.0`
is unchanged.

## 1.0.0 — Initial public release

Publish-readiness pass after multiple independent audits (packaging,
runtime parity, DX/types). Ships 1:1 behavioral parity with the Python
SDK at the same version number.


### Parity vs Python (ground truth)

- **`emitTelemetry` fallback latch** now only trips on true connect
  errors (`isConnectError`), matching `client.py:1071-1077`. A
  transient JSON parse error or `AbortError` from `close()` no longer
  permanently redirects all traffic to `workers.dev`.
- **`safeInject` always clears `lastMapByPage`** before the injection
  check, matching `client.py:1258-1260`. Prevents `execute()` from
  ever operating on a stale coordinate map when the mid-injection
  pipeline throws.
- **`absorbBillingResponse` 402 guard** predicate fixed: `eventType ==
  null` now falls THROUGH to the credits-exhausted path (defensive
  parity — a future call site without an explicit event must not
  silently swallow a real 402). Matches Python `client.py:1109`.
- **Mapper inject mechanism** switched from `new Function(s)()` wrapper
  to indirect `(0, eval)(s)` — runs the mapper in true global scope,
  matching `page.evaluate(self.core_js)` in Python.
- **`/v1/telemetry` `meta`** is now sent as `meta ?? {}` — never
  `undefined` on the wire, matching Python's `meta or {}`.
- **`NAVIGATE` missing-url error** string aligned byte-for-byte with
  Python (`"NAVIGATE requires \`url\`"`).
- **Telemetry PII scrub**: full `url` is no longer sent (was duplicate
  of `path` and commonly carries `?email=`/`?token=`); page `title` is
  scrubbed for email-shaped substrings before truncation.

### DX, types, and shutdown

- **`close()` is now real**: aborts every in-flight `fetch()` (telemetry,
  version check, capture) via a class-level `AbortController`. After
  `await aliax.close()`, no further network I/O leaves the process.
- **`AliaxConfigError`** added (extends `AliaxError`). The constructor
  and the bundled-mapper loader now throw `AliaxConfigError` instead of
  raw `TypeError`/`Error` — callers catching `AliaxError` see config
  failures alongside runtime failures, and discriminating code can
  target `AliaxConfigError` specifically.
- **`parseUi()` always throws `AliaxError`**: raw Playwright errors
  (`Frame was detached`, `Execution context was destroyed`) are now
  wrapped before bubbling out, matching the `execute()` contract.
- **`captureFailure` return type** extracted as a named
  `CaptureFailureResult` interface — annotate variables and write
  helper functions without `Awaited<ReturnType<…>>`.
- **`SDK_VERSION`** is now exported from the package entry — mirrors
  Python's `aliax.__version__`, useful for health-check endpoints.
- **`Decision.action`** narrowed from `DecisionAction | string` to
  `DecisionAction` so IDE completions list every verb and
  `decision.action === "CLICK"` narrows correctly.
- **`ExecuteResult` index signature removed** — every key the SDK ever
  emits is declared by name, so bracket access and `{ ok, ...rest }`
  destructuring preserve their narrow types.
- **`AliaxPage.waitForLoadState`** narrowed from `string` to the
  Playwright `LifecycleEvent` literal union (`"load" |
  "domcontentloaded" | "networkidle" | "commit"`).
- **`AliaxLocator.evaluate`** gained the missing `options?: { timeout?
  }` third parameter to match real Playwright `Locator.evaluate`.
- **`AttemptedActionInit`** renamed from `AttemptedAction` (interface);
  the runtime export `AttemptedAction` (class) is now the single
  authoritative name. The legacy alias is retained as deprecated.
- **JSDoc** added with `@param` / `@returns` / `@throws` / `@example`
  on every major public method (`parseUi`, `execute`, `reportIssue`,
  `captureFailure`, `getElementCoords`, `billingStatus`, `close`,
  `ParseContext` + every field including `truncated`, every
  `routeContextBlock`/`llmTextBlock` helper, `RenderConfig.quality`,
  `redactSelectors`, `AliaxOptions.telemetry`).
- **Deprecation noise** removed: `capture()` no longer double-emits
  (`process.emitWarning` + `console.warn`) — only `emitWarning` (the
  canonical Node channel) is used now.
- **`scrollDir[raw]` double-access** replaced with a single-lookup
  pattern — eliminates a latent `noUncheckedIndexedAccess` foot-gun.
- **All `AbortController` timers `unref()`'d** (telemetry, version
  check) so a fire-and-forget background ping never delays process
  exit.

### Packaging & distribution

- **`author`** field set for npm attribution.

- **`sideEffects: false`** — bundlers (Webpack/Rollup/esbuild) now
  tree-shake unused exports.
- **`repository.directory`** fixed to `aliax-node-sdk` (was a stale
  monorepo-relative path that 404'd the npm "Source" link).
- **`assets/dom-mapper.min.js` removed from `files`** — duplicate of
  the `dist/` copy, was ~35 kB of dead tarball weight.
- **`_domMapperIntegrity`** field records the SHA-256 of the shipped
  mapper for enterprise security review. The build script verifies the
  hash and hard-fails on mismatch.
- **`exports` map** gained a `"require"` condition pointing to a CJS
  guard stub that throws an actionable `ERR_REQUIRE_ESM` substitute,
  plus a `"default"` fallback for tools that don't recognise
  `"import"`.
- **`main` field removed** — was misleading (pointed at an ESM `.js`
  in a `"type": "module"` package, which CJS resolvers cannot consume
  anyway). `exports` is now the single source of truth.
- **`build` / `build:tests` scripts** moved from inline `node -e
  "require(…)"` (CJS smuggled into an ESM package) to a proper
  `scripts/copy-assets.mjs`.
- **`engines.node`** pinned to `>=18.0.0` (explicit patch floor).
- **Keywords** expanded with `computer-use`, `rpa`, `web-scraping`,
  `ai-browser`, `ai-agents`, `set-of-marks` for npm discoverability.
- **`LICENSE`** copyright year widened to `2025-2026`.

### Core parity features (vs Python SDK)

- Full feature parity with the Python SDK.
- React-friendly TYPE path with descriptor-bypass setter, `InputEvent`
  dispatch, and rich diagnostic readback (`stampResolved`, `stampTag`,
  `candidateSource`, `valueBefore`/`valueAfter`, `focusedAfterFocus`,
  `candidatesTried`, …) surfaced via `debugMode`.
- `verifyTypedValue` post-fallback read-back so silent TYPE mismatches
  surface in `debugMode` instead of disappearing.
- Three-tier element resolution: `Locator` → JS-click bypass → SPA-wipe
  rebind → coordinate fallback.
- "Three-Pronged Airbag" failure-detection net: state-stagnation hashing,
  action-cycle detection (period 2/3/4), and a `reportIssue` gatekeeper
  that rejects escalation without proof.
- `captureFailure` multipart upload with idempotency UUID, linear backoff
  retry, and one-shot `workers.dev` failover on connect-class errors.
- 3-tick (~9s) credit-grace recovery with fast-path re-check inside the
  lock so a background top-up never wastes a sleep tick.
- Image dimensions resolved from the JPEG header bytes first
  (matching Python's `_image_dimensions`), with viewport×dpr as fallback.
- `capture()` deprecation now uses `process.emitWarning(..., 'DeprecationWarning')`
  so CI flags (`node --throw-deprecation`) promote it to a fatal error.
- Concrete `AttemptedAction` class export (`new AttemptedAction({...})`)
  matching the Python dataclass surface.

## Publishing

For maintainers — release with provenance:

```bash
npm publish --provenance --access public
```

(Requires the GitHub Actions workflow to set
`permissions: { id-token: write, attestations: write }`.)

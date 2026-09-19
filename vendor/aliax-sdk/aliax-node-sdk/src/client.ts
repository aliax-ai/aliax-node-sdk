/**
 * Aliax SDK — TypeScript client (full feature parity with the Python SDK).
 *
 * Why this file is ~half the size of `aliax/client.py` while keeping
 * 100% of the behaviour (stagnation, cycle detection, DNA-stamp
 * locator tiers, telemetry adaptive ping, grace recovery, multipart
 * capture with idempotency UUID + retries + fallback swap, REPORT_ISSUE
 * Gatekeeper, COMBO, BATCH_TYPE, React-friendly TYPE):
 *
 *   - Node is single-threaded async, so all `threading.Lock` /
 *     `_http_lock_init` / `_grace_lock_init` / `_parse_locks_init`
 *     boilerplate disappears. Per-Page parse serialisation is just a
 *     Promise chained off a WeakMap entry.
 *   - `WeakMap` is a first-class primitive — zero `weakref` wrapper try
 *     blocks needed.
 *   - Background telemetry is a plain Promise (event loop keeps it
 *     alive; no strong-ref task set required).
 *   - The bundled mapper already returns `viewport.{width,height,dpr}`,
 *     so `imageSize` is derived mathematically (`width * dpr`) — no
 *     hand-rolled JPEG/PNG header parsers.
 *
 * The public surface (constructor, method names, decision schema,
 * server payload shape) is a mirror image of the Python SDK so an
 * AI developer moving between the two has zero learning curve.
 */

import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

import {
  AliaxConfigError,
  AliaxError,
  AliaxInvalidKeyError,
  AliaxOutOfCreditsError,
} from "./errors.js";
import * as anon from "./anon.js";
import { loadMapperSource } from "./mapper-asset.js";
import { ALIAX_SYSTEM_INSTRUCTIONS } from "./prompts.js";
import {
  jpegDimensions,
  imageDimensions,
  normaliseRenderConfig,
  type ResolvedRender,
} from "./render.js";
import type {
  AttemptedActionInit,
  BillingStatus,
  CaptureFailureOptions,
  CaptureFailureResult,
  Decision,
  ExecuteResult,
  MappedElement,
  ParseUiOptions,
  ReportIssueOptions,
  Viewport,
} from "./types.js";

/**
 * Installed SDK version (semver). Exported at module-level so callers
 * can log it from a health-check endpoint without constructing a client
 * — mirrors Python's `aliax.__version__`.
 */
export const SDK_VERSION = "1.0.5";
const _DEFAULT_FALLBACK =
  "https://aliax-cloudflare-worker.ogazievictorchi.workers.dev/v1";
const GRACE_TICKS = 3;
const GRACE_SLEEP_MS = 3000;
const MIN_STAGNATION = 3;
const MAX_HISTORY = 8;

/* ----------------------- Page / Locator shapes ----------------------- */

/**
 * Structural slice of `playwright.Page` the SDK needs. Typed as an
 * interface so we never import the playwright runtime here — peer-dep
 * model keeps the install footprint tiny.
 */
export interface AliaxLocator {
  click(opts?: { timeout?: number }): Promise<void>;
  hover(opts?: { timeout?: number }): Promise<void>;
  waitFor(opts?: { state?: string; timeout?: number }): Promise<void>;
  boundingBox(opts?: {
    timeout?: number;
  }): Promise<{ x: number; y: number; width: number; height: number } | null>;
  scrollIntoViewIfNeeded(opts?: { timeout?: number }): Promise<void>;
  evaluate<R = unknown, A = unknown>(
    fn: string | ((node: unknown, arg?: A) => R),
    arg?: A,
    options?: { timeout?: number },
  ): Promise<R>;
  first(): AliaxLocator;
}

/** Playwright lifecycle states accepted by `page.waitForLoadState`. */
export type AliaxLifecycleEvent =
  | "load"
  | "domcontentloaded"
  | "networkidle"
  | "commit";

export interface AliaxPage {
  url(): string;
  title(): Promise<string>;
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  evaluate<R = unknown, A = unknown>(
    fn: string | ((arg: A) => R),
    arg?: A,
  ): Promise<R>;
  screenshot(opts: { type: "jpeg" | "png"; quality?: number }): Promise<Buffer>;
  mouse: {
    click(x: number, y: number, opts?: unknown): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard: {
    type(text: string, opts?: { delay?: number }): Promise<void>;
    press(key: string): Promise<void>;
  };
  viewportSize(): { width: number; height: number } | null;
  waitForLoadState?(state: AliaxLifecycleEvent, opts?: { timeout?: number }): Promise<void>;
  waitForTimeout?(ms: number): Promise<void>;
  locator(selector: string): AliaxLocator;
}

/* ----------------------------- options ----------------------------- */

export interface AliaxOptions {
  /**
   * Bearer API key (`sk_live_...`) from the Aliax dashboard or `ALIAX_API_KEY` env var.
   *
   * Optional. When omitted and no `ALIAX_API_KEY` is found, the client automatically
   * bootstraps a free machine-scoped anonymous sandbox credential (500 free parses
   * residential / 100 cloud egress) cached in `~/.aliax/credentials` with zero signup.
   */
  apiKey?: string;
  endpoint?: string;
  fallbackEndpoint?: string | null;
  /**
   * Default `true`. When no `apiKey` and no `ALIAX_API_KEY` are found,
   * bootstrap a free machine-scoped sandbox credential so the SDK works
   * with zero signup. Pass `false` (or set `ALIAX_DISABLE_ANONYMOUS=1`)
   * to hard-fail instead — the right choice for locked-down enterprise
   * installs that must never talk to the edge unauthenticated.
   */
  allowAnonymous?: boolean;
  debugMode?: boolean;
  /**
   * CSS selectors of elements to blur in screenshots (and redact in the
   * spatial map) before any API call (`parseUi`, `captureFailure`).
   * Pixels are replaced with a solid grey box and text content is
   * stripped — DOM structure is preserved so the mapper still produces
   * a valid element list. Example:
   * `["[name='password']", "[autocomplete='cc-number']", ".ssn-input"]`.
   * **You are responsible for keeping this list in sync with your forms.**
   */
  redactSelectors?: string[];
  /** Default `true`. Pass `false` in airgapped envs. */
  checkForUpdates?: boolean;
  /**
   * Default `true`. Pass `false` to disable all *background* telemetry
   * (parse_ui / execute / refresh / grace-tick pings) and the
   * `checkForUpdates` round-trip. User-initiated `captureFailure()` and
   * `reportIssue()` calls still go to the API — those are explicit by
   * design. Useful for offline parity testing, SOC2 air-gapped
   * deployments, and self-hosted eval runs where billing latches must
   * stay at constructed defaults.
   */
  telemetry?: boolean;
  /** @deprecated since v1.0 — no-op accepted for pre-1.1 callers. */
  maxImageDim?: number;
}

/* ----------------------------- helpers ----------------------------- */

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    // unref() so a stray sleep (e.g. mid-grace-recovery when the agent
    // process is otherwise idle and the awaiter has been GC'd) doesn't
    // hold the event loop open and delay clean process exit.
    if (typeof (t as { unref?: () => void }).unref === "function") {
      (t as { unref: () => void }).unref();
    }
  });

/**
 * Selector-safe escape for an HTML attribute value embedded inside a
 * double-quoted CSS attribute selector (`[data-aliax-id="..."]`).
 * Stamps are LLM-supplied, so we escape backslash + quote and strip
 * control characters to keep a malformed stamp from corrupting the
 * selector grammar (defence-in-depth — the mapper already constrains
 * stamp shape server-side, but never trust upstream input).
 */
function cssAttrEscape(v: string): string {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "");
}

function decisionText(d: Decision): string {
  for (const k of ["value", "text_input", "input", "text"] as const) {
    const v = d[k];
    if (v != null) return String(v);
  }
  return "";
}
function decisionKey(d: Decision, fallback = "Enter"): string {
  for (const k of ["key", "text_input", "value", "input"] as const) {
    const v = d[k];
    if (v != null) return String(v);
  }
  return fallback;
}
function stampFromId(id?: string | null): string | null {
  if (!id) return null;
  const s = String(id).trim();
  if (!s) return null;
  return s.startsWith("el_") ? s.slice(3) : s;
}
function coerceAction(
  a: AttemptedActionInit | Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (a == null) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) if (v != null) out[k] = v;
  return out;
}

/** Strip email-looking substrings from telemetry strings (lightweight PII scrub). */
function scrubEmails(s: string): string {
  return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
}
function isContextDestroyed(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return (
    m.includes("Execution context was destroyed") ||
    m.includes("context was destroyed") ||
    m.includes("Target page, context or browser has been closed") ||
    m.includes("Frame was detached")
  );
}
function isIntercepted(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return (
    m.includes("intercept") ||
    m.includes("obscured") ||
    m.includes("outside of the viewport") ||
    m.includes("not stable") ||
    m.includes("element is not visible") ||
    m.includes("element is hidden")
  );
}
function isStampLost(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return (
    m.includes("not attached") ||
    m.includes("no element found") ||
    m.includes("no elements found") ||
    m.includes("waiting for selector") ||
    m.includes("locator resolved to 0 elements") ||
    (m.includes("timeout") && m.includes("exceeded"))
  );
}
/**
 * True iff `e` looks like a DNS / TCP-connect / network-unreachable
 * failure — i.e. a class of error where rotating to the fallback
 * endpoint is meaningful. Plain timeouts, HTTP-level errors, and JSON
 * serialisation TypeErrors do NOT count: failing those over to
 * workers.dev wouldn't help and would corrupt the fallback latch.
 */
function isConnectError(e: unknown): boolean {
  const err = e as Error & { code?: string; cause?: { code?: string } };
  const code = err?.code ?? err?.cause?.code ?? "";
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH"
  )
    return true;
  const m = String(err?.message ?? "").toLowerCase();
  return (
    m.includes("fetch failed") ||
    m.includes("econnrefused") ||
    m.includes("enotfound") ||
    m.includes("network") ||
    m.includes("getaddrinfo") ||
    m.includes("socket hang up")
  );
}
/**
 * Numeric semver compare (parity with Python's `_is_older`). Returns
 * true iff `current` < `latest`. Treats non-numeric segments as 0 so a
 * pre-release tag never spuriously wins the comparison.
 */
function isOlder(current: string, latest: string): boolean {
  const parse = (v: string) =>
    String(v)
      .split(/[.+-]/)
      .slice(0, 3)
      .map((p) => {
        const n = parseInt(p, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const [ca = 0, cb = 0, cc = 0] = parse(current);
  const [la = 0, lb = 0, lc = 0] = parse(latest);
  if (ca !== la) return ca < la;
  if (cb !== lb) return cb < lb;
  return cc < lc;
}

/* =================================================================== */
/*  Aliax client                                                       */
/* =================================================================== */

export class Aliax {
  static readonly SYSTEM_INSTRUCTIONS = ALIAX_SYSTEM_INSTRUCTIONS;
  readonly SYSTEM_INSTRUCTIONS = ALIAX_SYSTEM_INSTRUCTIONS;

  /**
   * Bearer credential. Declared (not initialized as a class field) so we
   * can install it via `Object.defineProperty` with `enumerable: false` —
   * keeps the key out of `JSON.stringify(client)` / `console.log(client)` /
   * `util.inspect(client)`. The runtime type is still `string`.
   */
  declare readonly apiKey: string;
  readonly sdkVersion = SDK_VERSION;
  debugMode: boolean;
  redactSelectors: string[];
  /** True iff `telemetry: false` was passed to the constructor. */
  private telemetryDisabled: boolean;

  private endpointBase: string;
  private fallbackBase: string | null;
  private fallbackActive = false;

  /** True when running on a free zero-signup sandbox credential. */
  anonymous = false;
  /** Grant details for the active sandbox credential (tier/remaining). */
  anonymousInfo: anon.AnonCredential | null = null;
  private anonymousPending = false;
  private anonRebootstrapped = false;
  private anonInFlight: Promise<void> | null = null;


  // Billing latches — same state machine as Python.
  private billingBalance: number | null = null;
  private creditsExhausted = false;
  private invalidKeyReason: string | null = null;
  // Serialises grace-recovery so a burst of 100 concurrent parseUi
  // calls on the moment of exhaustion does not fire 300 sync pings.
  private graceInFlight: Promise<boolean> | null = null;
  // One-shot latch for the `maxImageDim` deprecation warning so a chatty
  // agent loop doesn't spam stderr on every parseUi call.
  private maxImageDimWarned = false;
  /**
   * Aborts in-flight grace-recovery sleeps + future telemetry/version
   * pings once `close()` is called. Plumbed into every `fetch()` so a
   * caller doing `await aliax.close()` gets a hard guarantee of no
   * further network I/O within ~1ms.
   */
  private closeAbort = new AbortController();
  private closed = false;

  // Per-Page caches. WeakMap auto-evicts closed pages.
  private lastMapByPage = new WeakMap<AliaxPage, MappedElement[]>();
  private parseLockByPage = new WeakMap<AliaxPage, Promise<void>>();
  private injectedPages = new WeakSet<AliaxPage>();
  private mapperSource: string | null = null;
  private mapperTickets: string[] = [];
  private mapperSessionId: string | null = null;
  private mapperSessionInFlight: Promise<void> | null = null;
  // Failure-Detection Net (the "Three-Pronged Airbag").
  private stateHistoryByPage = new WeakMap<AliaxPage, string[]>();
  private actionHistoryByPage = new WeakMap<AliaxPage, (string | null)[]>();

  // Rejection message — phrased as behavioural feedback the LLM can act on.
  // String is byte-for-byte parity with Python's REPORT_REJECT_MSG so LLM
  // self-correction prompts and test assertions match across SDKs.
  private static readonly REPORT_REJECT_MSG =
    "REPORT_ISSUE rejected: insufficient stagnation evidence. The SDK has not " +
    "yet observed (a) three consecutive parse_ui rounds with an identical page " +
    "state, or (b) a repeating click sub-cycle across the same 2-4 elements " +
    "(e.g. [A,B,A,B] or [A,B,C,A,B,C]). You must attempt at least 2 DISTINCT " +
    "alternative actions on this screen before escalation is allowed — and " +
    "'distinct' means a different VERB (e.g. SCROLL or WAIT or HOVER), not the same verb " +
    "on a different element_id (which is exactly the cycling pattern the " +
    "Gatekeeper detects). Pull yourself together and try a different KIND of " +
    "action first.";

  /**
   * Create an Aliax client instance.
   *
   * **Zero-Setup Quickstart (No API Key Required):**
   * ```ts
   * const aliax = new Aliax(); // works immediately with free anonymous sandbox!
   * ```
   *
   * **Authentication modes:**
   * 1. **Anonymous sandbox (Default):** With no key, the SDK automatically provisions
   *    a free machine-scoped credential (500 parses residential / 100 cloud) cached
   *    in `~/.aliax/credentials`.
   * 2. **Personal API Key:** Pass `apiKey: "sk_live_..."` or set `ALIAX_API_KEY` for full
   *    dashboard telemetry, crash capture inbox, and 1,000 starter credits.
   * 3. **Enterprise Opt-Out:** Set `allowAnonymous: false` or `ALIAX_DISABLE_ANONYMOUS=1`
   *    to fail closed if no key is provided.
   */
  constructor(opts: AliaxOptions | string = {}) {
    const o: AliaxOptions =
      typeof opts === "string" ? { apiKey: opts } : { ...opts };
    this.endpointBase = (o.endpoint ?? "https://api.aliax.xyz/v1").replace(
      /\/+$/,
      "",
    );
    if (o.fallbackEndpoint === null) this.fallbackBase = null;
    else if (typeof o.fallbackEndpoint === "string")
      this.fallbackBase = o.fallbackEndpoint.replace(/\/+$/, "") || null;
    else
      this.fallbackBase =
        this.endpointBase === "https://api.aliax.xyz/v1"
          ? _DEFAULT_FALLBACK
          : null;

    // ---- Key resolution ------------------------------------------
    // 1. explicit option  2. ALIAX_API_KEY  3. cached anonymous sandbox
    // credential (sync file read)  4. fresh sandbox credential, minted
    // lazily on the first network call (constructors can't await).
    let key = o.apiKey ?? process.env.ALIAX_API_KEY ?? "";
    const envOptOut = (process.env.ALIAX_DISABLE_ANONYMOUS ?? "")
      .trim()
      .toLowerCase();
    const anonAllowed =
      o.allowAnonymous !== false &&
      !["1", "true", "yes"].includes(envOptOut) &&
      !o.debugMode;

    if (!key && anonAllowed) {
      const cached = anon.loadCached(this.endpointBase);
      if (cached) {
        key = cached.api_key;
        this.anonymous = true;
        this.anonymousInfo = cached;
      } else {
        // Deferred: the first telemetry/capture call awaits ensureKey().
        this.anonymous = true;
        this.anonymousPending = true;
      }
    }

    if (!key && !this.anonymousPending) {
      // Typed config error so callers catching `AliaxError` see it AND
      // callers branching on misconfiguration vs runtime failure can
      // target `AliaxConfigError` specifically. Python parity:
      // `ValueError`.
      throw new AliaxConfigError(
        "Aliax could not obtain an API key. Pass Aliax({ apiKey: 'sk_...' }), " +
          "set the ALIAX_API_KEY environment variable, or allow the free " +
          "anonymous sandbox. Create a free key at https://aliax.xyz/auth.",
      );
    }
    if (key && !key.startsWith("sk_")) {
      throw new AliaxConfigError(
        "Aliax({ apiKey }) must be a key starting with 'sk_'. " +
          "Pass it directly or set the ALIAX_API_KEY environment variable. " +
          "Generate one at https://aliax.xyz/api-keys.",
      );
    }
    // Install apiKey as a non-enumerable property so it does NOT appear
    // in `JSON.stringify(client)`, `console.log(client)`, or
    // `util.inspect(client)`. Stops accidental key leakage via error
    // reporters / log aggregators that serialise SDK instances.
    // `configurable` so a sandbox credential can be swapped in when it
    // is minted (or renewed after 30-day expiry).
    Object.defineProperty(this, "apiKey", {
      value: key,
      enumerable: false,
      writable: false,
      configurable: true,
    });

    this.debugMode = !!o.debugMode;
    this.telemetryDisabled = o.telemetry === false;
    this.redactSelectors = [...(o.redactSelectors ?? [])];
    // `maxImageDim` is a v0.x no-op kept for back-compat; just touch the
    // option so the param isn't flagged as unused in strict configs.
    void o.maxImageDim;


    if (o.checkForUpdates !== false && !this.debugMode && !this.telemetryDisabled) {
      // Fire-and-forget version ping. Node keeps the Promise alive; if
      // it rejects we swallow — version checks must never crash agents.
      void this.checkForUpdates().catch(() => {});
    }
  }

  /* -------------------------- billing API -------------------------- */

  /**
   * In-memory snapshot of the billing state machine. Cheap to call —
   * never hits the network. For a fresh round-trip use
   * {@link refreshBillingStatus}.
   *
   * @returns `{ locked, reason, balance, credits_exhausted }`. `locked`
   *   is terminal (API key was rejected); `credits_exhausted` self-heals
   *   on any successful 2xx telemetry response.
   */
  billingStatus(): BillingStatus {
    return {
      locked: this.invalidKeyReason !== null,
      reason: this.invalidKeyReason,
      balance: this.billingBalance,
      credits_exhausted: this.creditsExhausted,
    };
  }

  /** Force a network round-trip to refresh billing state. */
  async refreshBillingStatus(): Promise<BillingStatus> {
    await this.emitTelemetry("execute", 1, { reason: "refresh" });
    return this.billingStatus();
  }

  /**
   * Idempotent shutdown. Aborts every in-flight `fetch()` + grace sleep
   * so the process can exit cleanly. Safe to `await` multiple times.
   * After `close()` the client refuses to emit further background
   * telemetry — explicit user calls still work but will error if the
   * network fetch is in flight when called.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.closeAbort.abort();
    } catch {
      /* never throw from close */
    }
    // Drop the shared grace promise reference; awaiters get whatever
    // it already resolved to (or an AbortError they can swallow).
    this.graceInFlight = null;
  }

  /** TS 5.2+ `using` / `await using` resource-management hook → calls close(). */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /* ----------------------- debug-mode structured log ----------------------- */

  /**
   * Per-sub-step structured logger — mirror of Python's `_dbg`. Emits
   * one `[Aliax] <stage> k=v k=v ...` line per call so a `debugMode=true`
   * agent can grep its trace without attaching a debugger. Truncates
   * long string values to keep terminal output scannable.
   */
  private dbg(stage: string, fields: Record<string, unknown> = {}): void {
    if (!this.debugMode) return;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      let s: string;
      if (v == null) s = "null";
      else if (typeof v === "string") s = v;
      else {
        try {
          s = JSON.stringify(v);
        } catch {
          s = String(v);
        }
      }
      if (s.length > 120) s = s.slice(0, 120) + `…(+${s.length - 120})`;
      parts.push(`${k}=${s}`);
    }
    // eslint-disable-next-line no-console
    console.info(`[Aliax] ${stage}${parts.length ? " " + parts.join(" ") : ""}`);
  }

  /** @deprecated v0.2 back-compat alias — use captureFailure(). */
  async capture(
    page: AliaxPage,
    goal: string,
    opts: Omit<CaptureFailureOptions, "goal"> = {},
  ): Promise<CaptureFailureResult> {
    // Parity with Python's `warnings.warn(..., DeprecationWarning, stacklevel=2)`.
    // We use `process.emitWarning` (the canonical Node mechanism — picked
    // up by `--throw-deprecation` and log aggregators) and DO NOT also
    // call `console.warn`: double-emission was confusing log pipelines
    // (Sentry/Datadog ingest both channels) without adding signal.
    try {
      process.emitWarning(
        "aliax.capture() is a v0.2 alias for captureFailure() and will " +
          "be removed in a future major release. Migrate to " +
          "aliax.parseUi() + aliax.execute() for the live interceptor flow, " +
          "or call aliax.captureFailure() / aliax.reportIssue() directly.",
        {
          type: "DeprecationWarning",
          code: "DEP_ALIAX_CAPTURE",
        },
      );
    } catch {
      /* older Node — silent */
    }
    return this.captureFailure(page, { goal, ...opts });
  }

  /* -------------------------- HTTP plumbing -------------------------- */

  private url(path: string): string {
    return `${this.endpointBase}/${path.replace(/^\/+/, "")}`;
  }
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Aliax-SDK-Version": SDK_VERSION,
      ...extra,
    };
  }
  private maybeSwapToFallback(): boolean {
    if (this.fallbackActive || !this.fallbackBase) return false;
    this.fallbackActive = true;
    this.endpointBase = this.fallbackBase;
    // Production log-aggregator signal — primary API is down. Stays a
    // warning (not error) because the fallback usually succeeds.
    // eslint-disable-next-line no-console
    console.warn(
      `[Aliax] Primary endpoint unreachable; failing over to ${this.fallbackBase}`,
    );
    return true;
  }

  /** Parse a telemetry/capture response and update billing latches. */
  private absorbBillingResponse(
    status: number,
    body: unknown,
    eventType?: string,
  ): void {
    const b = (body && typeof body === "object" ? body : {}) as Record<
      string,
      unknown
    >;
    if (Array.isArray(b.tickets)) {
      this.mapperTickets.push(...b.tickets.filter((t): t is string => typeof t === "string"));
    }
    // Match Python: missing `balance` coerces to 0 (so a server that
    // omits the field flips us into strict telemetry mode rather than
    // silently leaving the cached value stale).
    if ("balance" in b) {
      const raw = b.balance;
      if (typeof raw === "number") this.billingBalance = raw;
      else if (raw == null) this.billingBalance = 0;
      else {
        const n = Number(raw);
        this.billingBalance = Number.isFinite(n) ? n : 0;
      }
    }
    if (status === 402) {
      // Free events that 402 = server billing misconfig. Log loudly so
      // ops sees it, but do NOT latch the credits-exhausted state for
      // non-billable events. Predicate mirrors Python `client.py:1109`:
      // `eventType is None OR eventType not in billable_set` — so an
      // omitted `eventType` falls THROUGH to the credits-exhausted path
      // (defensive: a future call site without an explicit event must
      // not silently swallow a 402).
      if (eventType != null && eventType !== "parse_ui" && eventType !== "execute") {
        // eslint-disable-next-line no-console
        console.error(
          `[Aliax] Server returned 402 for non-billable event ${eventType} — ` +
            `billing misconfiguration suspected.`,
        );
        return;
      }
      this.creditsExhausted = true;
      if (this.anonymous || b.code === "sandbox_exhausted") {
        // A sandbox grant can't be topped up — the only exit is a free
        // account, so say that instead of "top up".
        // eslint-disable-next-line no-console
        console.error(
          `[Aliax] Free anonymous sandbox allowance is used up. Create a ` +
            `free account (1,000 credits) at ${anon.SIGNUP_URL} and set ALIAX_API_KEY.`,
        );
        return;
      }
      // eslint-disable-next-line no-console
      console.error(
        `[Aliax] Past overdraft floor (balance=${this.billingBalance}). ` +
          `Top up at https://aliax.xyz/dashboard.`,
      );
      return;
    }
    if (status === 401) {
      // An expired 30-day sandbox credential is not an operator error —
      // mint a replacement instead of locking the agent loop.
      if (b.rebootstrap && this.anonymous && !this.anonRebootstrapped) {
        this.anonRebootstrapped = true;
        anon.clearCached();
        this.anonymousPending = true;
        this.anonymousInfo = null;
        return;
      }
      const code = String(b.code ?? "invalid_api_key");
      this.invalidKeyReason =
        code === "revoked_key" || code === "revoked_api_key"
          ? "revoked_api_key"
          : code === "expired_key" || code === "expired_api_key"
            ? "expired_api_key"
            : "invalid_api_key";
      // eslint-disable-next-line no-console
      console.error(
        `[Aliax] API key rejected by server (${this.invalidKeyReason}). Calls are locked.`,
      );
      return;
    }

    if (status >= 200 && status < 300 && (b.ok || b.status === "ok")) {
      // Successful debit ⇒ we're above the overdraft floor. Self-heal.
      if (this.creditsExhausted) {
        this.creditsExhausted = false;
        // eslint-disable-next-line no-console
        console.info(
          `[Aliax] Balance restored (balance=${this.billingBalance}) — resuming normal operation.`,
        );
      }
    }
  }

  /**
   * Resolve a deferred anonymous sandbox credential. Called before every
   * authenticated network hop; a no-op (single `if`) once a key exists.
   * Serialised so a burst of concurrent parseUi calls mints exactly one
   * credential. Never throws — a failed mint leaves the request to fail
   * with the server's own 401, which is a clearer signal than a
   * transport traceback from inside the bootstrap.
   */
  private async ensureKey(): Promise<void> {
    if (!this.anonymousPending) return;
    if (this.anonInFlight) return this.anonInFlight;
    this.anonInFlight = (async () => {
      const bases = [this.endpointBase];
      if (this.fallbackBase) bases.push(this.fallbackBase);
      for (const base of bases) {
        try {
          const cred = await anon.bootstrap(base, SDK_VERSION);
          Object.defineProperty(this, "apiKey", {
            value: cred.api_key,
            enumerable: false,
            writable: false,
            configurable: true,
          });
          this.anonymous = true;
          this.anonymousInfo = cred;
          this.anonymousPending = false;
          this.invalidKeyReason = null;
          // eslint-disable-next-line no-console
          console.warn(
            `[Aliax] Running on a free anonymous sandbox key ` +
              `(${cred.tier ?? "unknown"} tier, ${cred.remaining}/${cred.granted} ` +
              `parses left, expires ${cred.expires_at}). Crash captures and the ` +
              `dashboard need a free account: ${anon.SIGNUP_URL}`,
          );
          return;
        } catch (e) {
          if (e instanceof anon.AnonymousQuotaExhaustedError) {
            this.creditsExhausted = true;
            this.anonymousPending = false;
            // eslint-disable-next-line no-console
            console.error(`[Aliax] ${e.message}`);
            return;
          }
          // Try the workers.dev fallback before giving up.
        }
      }
    })().finally(() => {
      this.anonInFlight = null;
    });
    return this.anonInFlight;
  }

  private async emitTelemetry(

    eventType: string,
    units: number,
    meta: Record<string, unknown>,
  ): Promise<void> {
    if (this.debugMode || this.telemetryDisabled || this.closed) return;
    await this.ensureKey();
    // `units` is intentionally unread on the wire — the Python SDK
    // computes billing units server-side from `event`, and the wire
    // contract is `{event, sdk_version, meta}`. The param stays in the
    // signature for symmetry with Python's positional API but is not
    // forwarded.
    void units;
    try {
      const controller = new AbortController();
      // Forward `close()` aborts so a pending background ping doesn't
      // outlive shutdown.
      const onClose = () => controller.abort();
      this.closeAbort.signal.addEventListener("abort", onClose, { once: true });
      // Match Python's 2s timeout: on the strict (overdraft) path this
      // call is awaited, so a 5s stall would freeze the agent loop.
      const t = setTimeout(() => controller.abort(), 2000);
      // unref() — a fire-and-forget background ping must never delay
      // `process.exit()` waiting on its own abort timer.
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
      try {
        const res = await fetch(this.url("telemetry"), {
          method: "POST",
          headers: this.authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            event: eventType,
            sdk_version: SDK_VERSION,
            // Defensive: Python sends `meta or {}` — never `null`. A future
            // caller passing `undefined` here must produce `{}` on the wire,
            // not a dropped key.
            meta: meta ?? {},
            session_id: this.mapperSessionId,
          }),
          signal: controller.signal,
        });
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        this.absorbBillingResponse(res.status, body, eventType);
      } finally {
        clearTimeout(t);
        this.closeAbort.signal.removeEventListener("abort", onClose);
      }
    } catch (e) {
      // Parity with Python `client.py:1071-1077`: only true network-layer
      // failures should trip the fallback latch. Plain timeouts, JSON
      // TypeErrors, AbortErrors from `close()` must NOT permanently
      // redirect all traffic to workers.dev.
      if (isConnectError(e)) this.maybeSwapToFallback();
    }
  }

  private async ensureLicensed(): Promise<void> {
    if (this.mapperSource && this.mapperTickets.length > 0) return;
    if (this.mapperSessionInFlight) return this.mapperSessionInFlight;
    this.mapperSessionInFlight = (async () => {
      if (this.mapperSource && this.mapperTickets.length === 0) {
        await this.emitTelemetry("version_check", 1, { reason: "mapper_ticket_refresh" });
        if (this.mapperTickets.length > 0) return;
        throw new AliaxError("Aliax execution ticket renewal failed; telemetry is required to continue.");
      }
      await this.ensureKey();
      const res = await fetch(this.url("auth/session"), {
        method: "POST",
        headers: this.authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sdk_version: SDK_VERSION }),
        signal: this.closeAbort.signal,
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (!res.ok) {
        this.absorbBillingResponse(res.status, body, "version_check");
        throw new AliaxError(`Aliax mapper session rejected (${res.status}).`);
      }
      const key = typeof body.asset_key === "string" ? body.asset_key : "";
      if (!/^[0-9a-f]{64}$/i.test(key)) throw new AliaxError("Aliax mapper session returned no valid asset key.");
      this.mapperSource = loadMapperSource(key.toLowerCase());
      this.mapperSessionId = typeof body.session_id === "string" ? body.session_id : null;
      this.mapperTickets = Array.isArray(body.tickets)
        ? body.tickets.filter((t): t is string => typeof t === "string")
        : [];
      if (!this.mapperTickets.length) throw new AliaxError("Aliax mapper session has no execution tickets.");
    })().finally(() => { this.mapperSessionInFlight = null; });
    return this.mapperSessionInFlight;
  }

  private nextMapperTicket(): string {
    const ticket = this.mapperTickets.shift();
    if (!ticket) throw new AliaxError("Aliax execution ticket exhausted; wait for telemetry renewal.");
    return ticket;
  }

  /** Fire-and-forget telemetry — Node keeps the Promise alive. */
  private telemetryInBackground(
    eventType: string,
    units: number,
    meta: Record<string, unknown>,
  ): void {
    void this.emitTelemetry(eventType, units, meta);
  }

  /** 3-tick (~9s) grace loop, serialised across concurrent callers. */
  private async graceRecover(): Promise<boolean> {
    // Fast-path BEFORE waiting on graceInFlight: if background telemetry
    // already cleared the latch while we were queued, skip the sleep.
    // Mirrors Python `client.py:1396` which re-checks inside the lock.
    if (!this.creditsExhausted) return true;
    if (this.graceInFlight) return this.graceInFlight;
    const run = (async () => {
      if (!this.creditsExhausted) return true;
      for (let tick = 0; tick < GRACE_TICKS; tick++) {
        await sleep(GRACE_SLEEP_MS);
        await this.emitTelemetry("execute", 1, {
          reason: "grace_check",
          tick: tick + 1,
        });
        if (this.invalidKeyReason) return false;
        if (!this.creditsExhausted) return true;
      }
      return !this.creditsExhausted;
    })();
    this.graceInFlight = run;
    try {
      return await run;
    } finally {
      this.graceInFlight = null;
    }
  }

  private async checkForUpdates(): Promise<void> {
    if (this.closed) return;
    try {
      const controller = new AbortController();
      const onClose = () => controller.abort();
      this.closeAbort.signal.addEventListener("abort", onClose, { once: true });
      const t = setTimeout(() => controller.abort(), 1000);
      // unref() so a stalled version check never blocks process exit.
      if (typeof (t as { unref?: () => void }).unref === "function") {
        (t as { unref: () => void }).unref();
      }
      try {
        const res = await fetch(this.url("version"), {
          method: "GET",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as {
          latest_sdk?: string;
        };
        // Semver compare (parity with Python's `_is_older`) — never warn
        // when the installed SDK is newer than the server's published
        // `latest_sdk` (beta builds, pre-release wheels).
        if (data.latest_sdk && isOlder(SDK_VERSION, data.latest_sdk)) {
          console.warn(
            `[Aliax] SDK ${SDK_VERSION} installed; ${data.latest_sdk} is available. ` +
              `Run 'npm i -U aliax' to update.`,
          );
        }
      } finally {
        clearTimeout(t);
        this.closeAbort.signal.removeEventListener("abort", onClose);
      }
    } catch (e) {
      // Only swap on a real connect error — matches `emitTelemetry`.
      if (isConnectError(e)) this.maybeSwapToFallback();
    }
  }

  /* ------------------ mapper injection / nav-safe eval ------------------ */

  private async safeInject(page: AliaxPage): Promise<void> {
    // Parity with Python `_safe_inject` (client.py:1258): ALWAYS drop the
    // stale spatial map first — even on the fast path. If a subsequent
    // step throws before `parseUiOnce` writes a fresh map, `execute()`
    // must NOT operate against last-parse's stale bounds.
    this.lastMapByPage.delete(page);
    await this.ensureLicensed();
    if (this.injectedPages.has(page)) {
      // Defensive — SPA hard nav blows away `window.__AliaxCore`.
      const present = await page
        .evaluate<boolean>("typeof window.__AliaxCore !== 'undefined'")
        .catch(() => false);
      if (present) return;
    }
    const src = this.mapperSource ?? loadMapperSource();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Indirect-eval (`(0, eval)`) runs the mapper source in GLOBAL
        // scope — exact parity with Python's `page.evaluate(self.core_js)`.
        // The previous `new Function(s)()` wrapper added a synthetic
        // function scope that could swallow `var`/`function` declarations
        // the mapper relies on at top level.
        await page.evaluate<void, string>((s) => {
          // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
          (0, eval)(s);
        }, src);
        this.injectedPages.add(page);
        return;
      } catch (e) {
        if (attempt === 0 && isContextDestroyed(e)) {
          await page
            .waitForLoadState?.("domcontentloaded", { timeout: 10_000 })
            .catch(() => {});
          continue;
        }
        throw e;
      }
    }
  }

  private async safeEval<R = unknown, A = unknown>(
    page: AliaxPage,
    expr: string | ((a: A) => R),
    arg?: A,
  ): Promise<R> {
    // Playwright-node `page.evaluate(stringExpr, arg)` does NOT pass `arg`
    // into the string (unlike playwright-python). Detect string-expr + arg
    // and rewrite to an IIFE that embeds the JSON-serialised argument, so
    // existing call sites keep working without per-site refactors.
    let evalTarget: string | ((a: A) => R) = expr;
    let evalArg: A | undefined = arg;
    if (typeof expr === "string" && arg !== undefined) {
      try {
        const json = JSON.stringify(arg);
        // The string expression is expected to be a (...args)=>... arrow
        // (parity with how Python SDK passes it). Wrap as immediate call.
        evalTarget = `(${expr})(${json})`;
        evalArg = undefined;
      } catch {
        /* fall through to raw evaluate — Playwright will error if arg unserialisable */
      }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return (await page.evaluate(evalTarget as never, evalArg as never)) as R;
      } catch (e) {
        if (attempt === 0 && isContextDestroyed(e)) {
          this.injectedPages.delete(page);
          this.lastMapByPage.delete(page);
          await page
            .waitForLoadState?.("domcontentloaded", { timeout: 10_000 })
            .catch(() => {});
          await this.safeInject(page);
          continue;
        }
        throw e;
      }
    }
    throw new AliaxError("safeEval: unreachable");
  }

  /* ----------------------- Failure-Detection Net ----------------------- */

  private recordState(page: AliaxPage, url: string, elements: MappedElement[]): void {
    try {
      const sig = elements.map((e) => [
        e.element_id,
        e.tag,
        (e.text ?? "").slice(0, 64),
        e.bounds
          ? [e.bounds.x, e.bounds.y, e.bounds.width, e.bounds.height]
          : null,
      ]);
      const blob = JSON.stringify([url, sig]);
      const digest = createHash("sha256").update(blob).digest("hex");
      let hist = this.stateHistoryByPage.get(page);
      if (!hist) {
        hist = [];
        this.stateHistoryByPage.set(page, hist);
      }
      hist.push(digest);
      if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
    } catch {
      /* never crash on bookkeeping */
    }
  }

  private recordAction(page: AliaxPage, elementId: string | null): void {
    let hist = this.actionHistoryByPage.get(page);
    if (!hist) {
      hist = [];
      this.actionHistoryByPage.set(page, hist);
    }
    hist.push(elementId ?? null);
    if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
  }

  private resetFailureHistory(page: AliaxPage): void {
    this.stateHistoryByPage.delete(page);
    this.actionHistoryByPage.delete(page);
  }

  /**
   * `(eligible, reason)` — either 3 identical state hashes (frozen DOM)
   * OR a repeating action cycle of period 2/3/4 with DISTINCT members
   * per period (so legitimate "Load More" repeats don't escalate).
   */
  private failureProof(page: AliaxPage): { eligible: boolean; reason: string | null } {
    const sh = this.stateHistoryByPage.get(page) ?? [];
    if (sh.length >= MIN_STAGNATION) {
      const tail = sh.slice(-MIN_STAGNATION);
      if (new Set(tail).size === 1) return { eligible: true, reason: "state_stagnation" };
    }
    const ah = this.actionHistoryByPage.get(page) ?? [];
    for (const period of [2, 3, 4]) {
      const win = period * 2;
      if (ah.length < win) continue;
      const chunk = ah.slice(-win);
      const head = chunk.slice(0, period);
      const tail = chunk.slice(period);
      const allDefined = chunk.every((x) => x != null);
      const sameSeq = head.every((v, i) => v === tail[i]);
      const distinct = new Set(head).size === period;
      if (allDefined && sameSeq && distinct)
        return { eligible: true, reason: "action_cycle" };
    }
    return { eligible: false, reason: null };
  }

  /* ------------------------- per-Page parse lock ------------------------- */

  private async withParseLock<T>(page: AliaxPage, fn: () => Promise<T>): Promise<T> {
    const prev = this.parseLockByPage.get(page) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((res) => (release = res));
    this.parseLockByPage.set(page, prev.then(() => slot));
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  /* ============================== parseUi ============================== */

  /**
   * Translate the live page into a Set-of-Mark screenshot + structured
   * element map. Hand both to your VLM, then call {@link execute} with
   * the returned decision.
   *
   * @param page  A Playwright `Page` (or anything satisfying {@link AliaxPage}).
   * @param opts  Optional render / filter config.
   *   - `renderConfig`: `{ format, quality }` — JPEG-80 by default.
   *   - `drawOverlay`: paint the Set-of-Mark boxes (default `true`).
   *   - `minSize`: drop sub-`N`-pixel interactable nodes (default `12`).
   *   - `maxElements`: hard cap on the element list (default `200`).
   *     If hit, the returned `ctx.truncated` is `true` — your VLM is
   *     receiving an incomplete map; bump the cap or SCROLL to reveal more.
   * @returns A {@link ParseContext} with `imageBytes`, `imageMime`,
   *   `imageSize`, `elements`, `viewport`, `url`, `path`, `title`, and
   *   `truncated`. Call `.llmTextBlock()` for the text payload to ship
   *   to the VLM, `.routeContextBlock()` for a navigation hint header.
   *
   * @throws {@link AliaxInvalidKeyError} — API key rejected server-side (terminal).
   * @throws {@link AliaxOutOfCreditsError} — account past overdraft floor after grace loop.
   * @throws {@link AliaxError} — unrecoverable Playwright / mapper failure.
   *
   * @example
   *   const ctx = await aliax.parseUi(page);
   *   const decision = await askLLM(ctx.imageBytes, ctx.llmTextBlock());
   *   await aliax.execute(page, decision);
   */
  async parseUi(page: AliaxPage, opts: ParseUiOptions = {}): Promise<ParseContext> {
    if (this.invalidKeyReason) throw new AliaxInvalidKeyError(this.invalidKeyReason);
    // One-shot deprecation warning for the v0.x `maxImageDim` no-op.
    if (opts.maxImageDim && !this.maxImageDimWarned) {
      this.maxImageDimWarned = true;
      console.warn(
        "[Aliax] maxImageDim is a no-op since v1.0. Use renderConfig.quality for size control instead.",
      );
    }
    if (this.creditsExhausted) {
      const ok = await this.graceRecover();
      if (this.invalidKeyReason) throw new AliaxInvalidKeyError(this.invalidKeyReason);
      if (!ok) throw new AliaxOutOfCreditsError(this.billingBalance);
    }
    try {
      return await this.parseUiOnce(page, opts, false);
    } catch (e) {
      // Re-throw typed SDK errors as-is; wrap everything else (raw
      // Playwright `Frame was detached`, `context destroyed`, …) so
      // callers catching `AliaxError` never see an opaque foreign error.
      if (e instanceof AliaxError) throw e;
      throw new AliaxError(
        `parseUi failed: ${(e as Error)?.message ?? String(e)}`,
      );
    }
  }

  private async parseUiOnce(
    page: AliaxPage,
    opts: ParseUiOptions,
    internalRetry: boolean,
  ): Promise<ParseContext> {
    // Fold v0.x legacy `imageFormat` / `imageQuality` kwargs into the
    // resolved render config — matches Python's `_normalize_render_config(
    // render_config, legacy_format=..., legacy_quality=...)`.
    const cfg = normaliseRenderConfig(
      opts.renderConfig,
      opts.imageFormat,
      opts.imageQuality,
    );
    const drawOverlay = opts.drawOverlay !== false;
    const minSize = opts.minSize ?? 12;
    const maxElements = opts.maxElements ?? 200;
    const selectorsJson = JSON.stringify(this.redactSelectors);

    let imageBytes: Buffer = Buffer.alloc(0);
    let elements: MappedElement[] = [];
    let viewport: Viewport = defaultViewport();
    let truncated = false;
    let urlBefore = "";
    let navEpochBefore: number | null = null;
    let navDetected = false;

    await this.withParseLock(page, async () => {
      await this.safeInject(page);

      try {
        urlBefore = page.url();
      } catch {
        urlBefore = "";
      }
      try {
        const ep = await this.safeEval<number>(
          page,
          "() => { window.__aliaxNavEpoch = (window.__aliaxNavEpoch || 0) + 1; return window.__aliaxNavEpoch; }",
        );
        navEpochBefore = typeof ep === "number" ? ep : null;
      } catch {
        navEpochBefore = null;
      }

      // BUG-8 parity: set the optimistic `blurred` flag BEFORE the JS
      // call. If `blurPII` mutates some elements then throws mid-loop
      // (context destroyed, partial DOM mutation), the `finally` below
      // still runs `unblurPII` and cleans the stale `aliax-redacted`
      // classes off the live page.
      let blurred = true;
      let overlayDrawn = false;
      try {
        await this.safeEval(page, `() => window.__AliaxCore.blurPII(${selectorsJson})`);

        const dom = await this.safeEval(
          page,
          "(o) => window.__AliaxCore.mapDOM(o)",
          { min_size: minSize, max_elements: maxElements, __t: this.nextMapperTicket() },
        );
        const unpacked = unpackDomResult(dom);
        elements = unpacked.elements;
        viewport = unpacked.viewport;
        truncated = unpacked.truncated;
        if (truncated) {
          // Production log signal (parity with Python `client.py:1726`) so
          // operators not running debugMode still see "why didn't the agent
          // find element X?" cases — the VLM is receiving an incomplete list.
          // eslint-disable-next-line no-console
          console.warn(
            `[Aliax] DOM mapper hit its element cap (${maxElements}); ` +
              `additional interactable elements exist but were not listed.`,
          );
        }

        if (drawOverlay && elements.length) {
          try {
            await this.safeEval(
              page,
              "(els) => window.__AliaxCore.drawOverlay(els)",
              elements,
            );
            overlayDrawn = true;
          } catch {
            /* overlay paint is best-effort */
          }
        }

        imageBytes = await page.screenshot(
          cfg.format === "jpeg"
            ? { type: "jpeg", quality: cfg.quality }
            : { type: "png" },
        );
      } finally {
        if (overlayDrawn) {
          await this.safeEval(
            page,
            "() => { if (window.__AliaxCore) window.__AliaxCore.clearOverlay(); }",
          ).catch(() => {});
        }
        if (blurred) {
          await this.safeEval(
            page,
            "() => { if (window.__AliaxCore) window.__AliaxCore.unblurPII(); }",
          ).catch(async () => {
            await sleep(300);
            await this.safeEval(
              page,
              "() => { if (window.__AliaxCore) window.__AliaxCore.unblurPII(); }",
            ).catch(() => {});
          });
        }
      }

      // Mid-parse navigation detection (URL change OR window-state reset).
      let urlNow = "";
      try {
        urlNow = page.url();
      } catch {
        urlNow = "";
      }
      const urlChanged = !!(urlBefore && urlNow && urlBefore !== urlNow);
      let epochDrift = false;
      if (navEpochBefore != null) {
        const after = await this.safeEval<number | null>(
          page,
          "() => window.__aliaxNavEpoch ?? null",
        ).catch(() => null);
        if (typeof after !== "number" || after !== navEpochBefore) epochDrift = true;
      }
      navDetected = urlChanged || epochDrift;
    });

    if (navDetected && !internalRetry) {
      // Recursive retry ONCE outside the lock — `_internal_retry` mode
      // suppresses telemetry so one user-visible call debits one credit.
      this.lastMapByPage.delete(page);
      return this.parseUiOnce(page, opts, true);
    }

    let url = "";
    try {
      url = page.url();
    } catch {
      url = "";
    }
    let pathname = "";
    if (url) {
      try {
        pathname = new URL(url).pathname || "";
      } catch {
        pathname = "";
      }
    }
    let title = "";
    try {
      const t = await page.title();
      if (typeof t === "string") title = t.trim().slice(0, 200);
    } catch {
      title = "";
    }

    // Image size resolution order (parity with Python `_image_dimensions`):
    // (1) parse the actual screenshot header bytes (JPEG or PNG) and divide
    // by dpr — most accurate on retina / non-integer dpr where viewport×dpr
    // disagrees with Playwright's own rounding; (2) fall back to mapper
    // viewport × dpr.
    const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
    const parsed = imageDimensions(imageBytes);
    const size: [number, number] = parsed
      ? [parsed[0], parsed[1]]
      : [
          Math.round((viewport.width || 0) * dpr),
          Math.round((viewport.height || 0) * dpr),
        ];

    this.lastMapByPage.set(page, elements);

    if (!internalRetry) {
      this.recordState(page, url, elements);

      const meta = {
        element_count: elements.length,
        // `path` already carries the route — `url` is dropped to avoid
        // leaking query-string PII (?email=…, ?token=…) to telemetry.
        // Operators wanting the full URL can flip on `debugMode`, which
        // dumps the raw request to disk and never POSTs to /v1/telemetry.
        path: pathname.slice(0, 120),
        // Page titles commonly carry user names ("John Smith — Inbox").
        // Scrub email-shaped substrings before trimming to 120 chars.
        title: scrubEmails(title).slice(0, 120),
        image_format: cfg.format,
        image_quality: cfg.format === "jpeg" ? cfg.quality : null,
        image_bytes: imageBytes.length,
      };
      if (this.billingBalance == null || this.billingBalance > 0) {
        this.telemetryInBackground("parse_ui", 1, meta);
      } else {
        await this.emitTelemetry("parse_ui", 1, meta);
        if (this.invalidKeyReason)
          throw new AliaxInvalidKeyError(this.invalidKeyReason);
      }
    }

    return new ParseContext({
      imageBytes,
      imageMime: `image/${cfg.format}`,
      imageSize: size,
      elements,
      viewport,
      url,
      path: pathname,
      title,
      truncated,
      render: cfg,
    });
  }

  /* ============================== execute ============================== */

  /**
   * Execute a single VLM-emitted {@link Decision} against `page`. Never
   * throws — failures land in `result.error` / `result.ok = false` so
   * orchestrators can loop without try/catch noise.
   *
   * Supports the full verb set declared by {@link DecisionAction}.
   * Three-tier element resolution: Locator → JS-click bypass →
   * SPA-wipe rebind → coordinate fallback. Refuses to click disabled
   * controls. `COMBO` / `BATCH_TYPE` may return
   * `status: "partial_success"` with `completed_steps[]` populated.
   *
   * @param page      Playwright page.
   * @param decision  Parsed VLM JSON (`{ action, element_id?, value?, … }`).
   * @param opts.typeDelayMs  Per-character delay for TYPE/TYPE_AND_ENTER. Default `50`.
   */
  async execute(
    page: AliaxPage,
    decision: Decision,
    opts: { typeDelayMs?: number } = {},
  ): Promise<ExecuteResult> {
    const typeDelay = opts.typeDelayMs ?? 50;
    const raw = String(decision.action ?? "").toUpperCase();

    // ---- Action aliases ----
    const scrollDir: Record<string, ["x" | "y", 1 | -1]> = {
      SCROLL_DOWN: ["y", 1],
      SCROLL_UP: ["y", -1],
      SCROLL_RIGHT: ["x", 1],
      SCROLL_LEFT: ["x", -1],
    };
    let action = raw;
    let scrollAxis: "x" | "y" | null = null;
    let scrollSign: 1 | -1 = 1;
    // Single-lookup pattern — avoids a double bracket access that
    // tripped `noUncheckedIndexedAccess` and silently bound undefined.
    const scrollEntry = scrollDir[raw];
    if (scrollEntry) {
      action = "SCROLL";
      [scrollAxis, scrollSign] = scrollEntry;
    }

    const result: ExecuteResult = { ok: false, action };

    // Action-level debug breadcrumb — parity with Python `_dbg("execute.begin")`
    // (client.py:1926). Full field set so a debugMode run can be diff'd
    // action-by-action against the dump artefact.
    this.dbg("execute.begin", {
      action,
      element_id: (decision.element_id ?? decision.id ?? null) as string | null,
      x: (decision.x ?? null) as number | null,
      y: (decision.y ?? null) as number | null,
      url: (decision.url ?? null) as string | null,
      key: (decision.key ?? null) as string | null,
      ms: (decision.ms ?? null) as number | null,
      has_value:
        action === "TYPE" || action === "TYPE_AND_ENTER"
          ? decisionText(decision) !== ""
          : null,
    });

    try {
      // -------- Terminal / metadata verbs --------
      if (action === "DONE" || action === "FINISH" || action === "NOOP") {
        result.ok = true;
      } else if (action === "REPORT_ISSUE") {
        const ctx = (decision.context as Record<string, unknown>) ?? {};
        const rep = await this.reportIssue(page, {
          reason: String(decision.reason ?? "Agent escalation via REPORT_ISSUE"),
          expectedOutcome: ctx.expected_outcome as string | undefined,
          actualOutcome: ctx.actual_outcome as string | undefined,
          goal: String(decision.goal ?? "Agent escalation via REPORT_ISSUE"),
          thoughts: decision.thoughts as string | undefined,
        });
        Object.assign(result, rep);
        result.ok = rep.status === "success";
        return result; // skip the execute telemetry — reportIssue debits its own
      } else if (action === "WAIT") {
        // Python `int(decision.get("ms") or 1000)` — falsy (0/"") coerces
        // to the 1s default. Use `||` (not `??`) to match.
        const ms = Math.max(0, Number(decision.ms || 1000));
        await sleep(ms);
        result.ok = true;
      } else if (action === "NAVIGATE") {
        const navUrl = String(decision.url ?? "").trim();
        const lo = navUrl.toLowerCase();
        if (!navUrl) {
          this.dbg("navigate.error", { reason: "missing-url" });
          // Byte-for-byte parity with Python `client.py:1989` so
          // cross-SDK test assertions match.
          result.error = "NAVIGATE requires `url`";
        } else if (!lo.startsWith("http://") && !lo.startsWith("https://")) {
          const scheme = lo.split(":", 1)[0] || "(empty)";
          this.dbg("navigate.blocked", { scheme, url: navUrl });
          result.error =
            "NAVIGATE blocked: only http:// and https:// URLs are allowed. " +
            `Got scheme ${scheme}`;
        } else {
          // Cross-page state would fake [A,B,A,B] cycles.
          this.injectedPages.delete(page);
          this.lastMapByPage.delete(page);
          this.resetFailureHistory(page);
          this.dbg("navigate.begin", { url: navUrl });
          await page.goto(navUrl, { waitUntil: "domcontentloaded" });
          const finalUrl = page.url();
          this.dbg("navigate.done", { requested: navUrl, final: finalUrl });
          result.ok = true;
          result.url = navUrl;
        }
      } else if (action === "COMBO") {
        await this.handleCombo(page, decision, typeDelay, result);
      } else if (action === "BATCH_TYPE") {
        await this.handleBatchType(page, decision, typeDelay, result);
      } else if (
        action === "CLICK" ||
        action === "HOVER" ||
        action === "TYPE" ||
        action === "PRESS" ||
        action === "TYPE_AND_ENTER"
      ) {
        await this.handleTargeted(page, action, decision, typeDelay, result);
      } else if (action === "SCROLL") {
        await this.handleScroll(page, decision, scrollAxis, scrollSign, result);
      } else {
        result.error = `Unknown action: ${action}`;
      }
    } catch (e) {
      result.ok = false;
      result.error = `${(e as Error).name ?? "Error"}: ${(e as Error).message ?? e}`;
    }

    // Cycle-detection bookkeeping. COMBO sub-actions self-record via
    // their recursive frames; BATCH_TYPE records only on success.
    if (
      action === "CLICK" ||
      action === "TYPE" ||
      action === "PRESS" ||
      action === "HOVER" ||
      action === "TYPE_AND_ENTER"
    ) {
      const id = String(decision.element_id ?? decision.id ?? "") || null;
      this.recordAction(page, id);
    } else if (action === "BATCH_TYPE") {
      // Python `client.py:2553` iterates `result.get("filled") or []` —
      // if the entire batch failed before filling anything, the ring is
      // intentionally NOT advanced. Match that behaviour exactly.
      for (const f of result.filled ?? []) {
        const fid = (f as { element_id?: string }).element_id ?? null;
        this.recordAction(page, fid);
      }
    } else if (action !== "COMBO") {
      this.recordAction(page, null);
    }

    // Telemetry — 1 unit per execute, success or not.
    this.telemetryInBackground("execute", 1, {
      action,
      ok: !!result.ok,
      tier: result.execution_tier ?? null,
    });
    // Parity with Python `_dbg("execute.end")` (client.py:2521).
    this.dbg("execute.end", {
      action,
      ok: !!result.ok,
      tier: result.execution_tier ?? null,
      element_id: result.element_id ?? null,
      coords: result.coords ?? null,
      error: result.error ?? null,
    });
    return result;
  }

  /* ------------------------- targeted action core ------------------------- */

  private async handleTargeted(
    page: AliaxPage,
    action: string,
    decision: Decision,
    typeDelay: number,
    result: ExecuteResult,
  ): Promise<void> {
    const elementId =
      (decision.element_id as string | undefined) ??
      (decision.id as string | undefined);
    const stamp = stampFromId(elementId);
    const cached = elementId ? this.cachedRecord(page, elementId) : null;
    const isCanvas = !!(cached && cached.is_canvas);

    // ---- State-aware safety catch: refuse to click disabled controls.
    if (
      (action === "CLICK" ||
        action === "TYPE" ||
        action === "PRESS" ||
        action === "TYPE_AND_ENTER") &&
      elementId &&
      !isCanvas
    ) {
      const disabled = await this.probeDisabled(page, stamp, cached);
      if (disabled) {
        result.error =
          `Action blocked: element ${elementId} is currently disabled (${disabled}). ` +
          `Inspect the surrounding form (unchecked required boxes, empty required ` +
          `fields, invalid inputs) and fix those first.`;
        result.element_id = elementId;
        result.execution_tier = "blocked_disabled";
        result.blocked = "disabled";
        this.telemetryInBackground("execute", 1, {
          action,
          ok: false,
          tier: "blocked_disabled",
        });
        return;
      }
    }

    // ---- Tier 1: DNA-stamp locator path.
    let stampOk = false;
    if (stamp && !isCanvas && decision.x == null && decision.y == null) {
      const r = await this.actViaLocator(page, stamp, action, decision, cached, typeDelay);
      if (r.ok) {
        stampOk = true;
        result.ok = true;
        result.element_id = elementId;
        Object.assign(result, r.extra);
        if (action === "CLICK" || action === "PRESS" || action === "TYPE_AND_ENTER") {
          await page
            .waitForLoadState?.("domcontentloaded", { timeout: 5000 })
            .catch(() => {});
          this.lastMapByPage.delete(page);
        }
      }
    }

    if (stampOk) return;

    // ---- Tier 2: coordinate fallback (canvases + legacy raw coords).
    const coords = await this.coordsFor(page, decision);
    if (!coords) {
      result.error =
        "Could not resolve element. Provide either `element_id` (from the most " +
        "recent parse_ui) or explicit `x`/`y` CSS-pixel coordinates.";
      return;
    }
    const { x, y } = coords;

    if (action === "HOVER") {
      await page.mouse.move(x, y);
    } else if (action === "CLICK") {
      await this.safeEval(
        page,
        "([x,y]) => window.scrollBy({left: Math.max(0,x-window.innerWidth/2-window.scrollX), top: Math.max(0,y-window.innerHeight/2-window.scrollY), behavior:'instant'})",
        [x, y],
      ).catch(() => {});
      await page.mouse.click(x, y);
      await page
        .waitForLoadState?.("domcontentloaded", { timeout: 5000 })
        .catch(() => {});
      this.lastMapByPage.delete(page);
    } else if (action === "TYPE" || action === "TYPE_AND_ENTER") {
      const value = decisionText(decision);
      const sfj = stampFromId(coords.element_id ?? elementId);
      let react = await this.setPlainEditableValue(page, value, sfj);
      if (!react?.ok) {
        await page.mouse.click(x, y);
        react = await this.setPlainEditableValue(page, value, sfj);
      }
      if (!react?.ok) {
        await page.keyboard.press("ControlOrMeta+A").catch(() => {});
        await page.keyboard.press("Backspace").catch(() => {});
        await page.keyboard.type(value, { delay: typeDelay });
        // Read-back parity with Python `_verify_typed_value`. We don't
        // currently surface the mismatch upward (parity with Python which
        // also just logs), but debugMode operators can see it.
        const verifyLabel = action === "TYPE_AND_ENTER"
          ? "coords.TYPE_AND_ENTER.keyboard-verify"
          : "coords.TYPE.keyboard-verify";
        await this.verifyTypedValue(page, sfj, value, verifyLabel);
      }
      if (action === "TYPE_AND_ENTER") {
        await page.keyboard.press("Enter");
        await page
          .waitForLoadState?.("domcontentloaded", { timeout: 5000 })
          .catch(() => {});
        this.lastMapByPage.delete(page);
        result.key = "Enter";
      }
      result.value = value;
    } else if (action === "PRESS") {
      const k = decisionKey(decision);
      await page.mouse.click(x, y);
      await page.keyboard.press(k);
      await page
        .waitForLoadState?.("domcontentloaded", { timeout: 5000 })
        .catch(() => {});
      this.lastMapByPage.delete(page);
      result.key = k;
    }
    result.ok = true;
    result.coords = [Math.round(x), Math.round(y)];
    result.execution_tier = "coords";
    if (coords.element_id) result.element_id = coords.element_id;
  }

  /** Locator-tier action with intercepted-bypass + SPA-wipe rebind. */
  private async actViaLocator(
    page: AliaxPage,
    stamp: string,
    action: string,
    decision: Decision,
    cached: MappedElement | null,
    typeDelay: number,
  ): Promise<{ ok: boolean; extra: Record<string, unknown> }> {
    const safe = cssAttrEscape(stamp);
    const sel = `[data-aliax-id="${safe}"]`;
    const locator = page.locator(sel).first();

    const postCoords = async (): Promise<[number, number] | null> => {
      try {
        const b = await locator.boundingBox({ timeout: 500 });
        if (b)
          return [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];
      } catch {
        /* fall through */
      }
      if (cached?.bounds) {
        return [
          Math.round(cached.bounds.x + cached.bounds.width / 2),
          Math.round(cached.bounds.y + cached.bounds.height / 2),
        ];
      }
      return null;
    };

    const doAction = async (tier: "locator" | "jsclick" | "rebind") => {
      const extra: Record<string, unknown> = { execution_tier: tier };
      if (action === "HOVER") {
        await locator.hover({ timeout: 4000 });
      } else if (action === "CLICK") {
        if (tier === "jsclick") await locator.evaluate("n => n.click()");
        else await locator.click({ timeout: 8000 });
      } else if (action === "TYPE" || action === "TYPE_AND_ENTER") {
        const value = decisionText(decision);
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        let react = await this.setPlainEditableValue(page, value, stamp);
        if (!react?.ok) {
          if (tier === "jsclick") await locator.evaluate("n => n.focus && n.focus()");
          else await locator.click({ timeout: 8000 });
          react = await this.setPlainEditableValue(page, value, stamp);
        }
        if (!react?.ok) {
          await page.keyboard.press("ControlOrMeta+A").catch(() => {});
          await page.keyboard.press("Backspace").catch(() => {});
          await page.keyboard.type(value, { delay: typeDelay });
          // Parity with Python `_verify_typed_value`.
          const verifyLabel = action === "TYPE_AND_ENTER"
            ? "locator.TYPE_AND_ENTER.keyboard-verify"
            : "locator.TYPE.keyboard-verify";
          await this.verifyTypedValue(page, stamp, value, verifyLabel);
        }
        if (action === "TYPE_AND_ENTER") {
          await page.keyboard.press("Enter");
          extra.key = "Enter";
        }
        extra.value = value;
      } else if (action === "PRESS") {
        const k = decisionKey(decision);
        if (tier === "jsclick") await locator.evaluate("n => n.focus && n.focus()");
        else await locator.click({ timeout: 8000 });
        await page.keyboard.press(k);
        extra.key = k;
      }
      const c = await postCoords();
      if (c) extra.coords = c;
      return extra;
    };

    try {
      await locator.waitFor({ state: "attached", timeout: 1500 });
      const extra = await doAction("locator");
      return { ok: true, extra };
    } catch (e1) {
      if (isIntercepted(e1)) {
        try {
          const extra = await doAction("jsclick");
          return { ok: true, extra };
        } catch {
          /* fall through to rebind */
        }
      }
      if (isStampLost(e1) && cached) {
        const hint = {
          element_id: cached.element_id,
          tag: cached.tag,
          text: cached.text,
          bounds: cached.bounds ?? {},
        };
        const rebound = await this.safeEval<{ rebound_from?: string } | null>(
          page,
          "(h) => window.__AliaxCore && window.__AliaxCore.rebindStamp(h)",
          hint,
        ).catch(() => null);
        if (rebound) {
          try {
            await locator.waitFor({ state: "attached", timeout: 1500 });
            const extra = await doAction("rebind");
            extra.rebound_from = rebound.rebound_from;
            return { ok: true, extra };
          } catch {
            /* fall through */
          }
        }
      }
      return { ok: false, extra: {} };
    }
  }

  /** Cache check + tiny live probe for disabled controls. */
  private async probeDisabled(
    page: AliaxPage,
    stamp: string | null,
    cached: MappedElement | null,
  ): Promise<string | null> {
    if (cached?.state?.disabled) {
      const hints: string[] = [];
      if (cached.state.required) hints.push("required field empty");
      if (cached.state.invalid) hints.push("invalid input flagged");
      if (cached.state.busy) hints.push("element is busy");
      return hints.length ? hints.join(", ") : "aria-disabled / disabled attribute";
    }
    if (!stamp) return null;
    try {
      const safe = cssAttrEscape(stamp);
      const r = await this.safeEval<string | null>(
        page,
        `(s) => {
          const el = document.querySelector('[data-aliax-id="' + s + '"]');
          if (!el) return null;
          if (el.disabled === true) return 'native disabled attribute';
          if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return 'aria-disabled=true';
          if (el.closest && el.closest('fieldset[disabled]')) return 'inside <fieldset disabled>';
          if (el.classList && (el.classList.contains('disabled') || el.classList.contains('is-disabled'))) return 'has .disabled class';
          return null;
        }`,
        safe,
      );
      return typeof r === "string" && r ? r : null;
    } catch {
      return null;
    }
  }

  /**
   * React-friendly value-write — descriptor-bypass setter, InputEvent,
   * change-event, blur, with read-back verification. Mirrors the Python
   * inline JS verbatim (this is the heart of TYPE reliability).
   *
   * The returned diag object carries the full Python `_set_plain_editable_value`
   * field set (`stampResolved`, `stampTag`, `stampDisabled`, `activeTag`,
   * `valueBefore`, `valueAfter`, `candidateSource`, `candidatesTried`, …) so
   * debug-mode failures can be pinpointed down to the exact candidate /
   * focus / mutation step that went wrong.
   */
  private async setPlainEditableValue(
    page: AliaxPage,
    value: string,
    stamp: string | null,
  ): Promise<{ ok: boolean; reason?: string; method?: string } | null> {
    try {
      const probe = await this.safeEval<Record<string, unknown> | null>(
        page,
        REACT_TYPE_FN,
        { s: stamp ?? null, v: value },
      );
      // Debug-mode breadcrumb — only fires when `debugMode=true`. Mirrors
      // Python `_dbg("set-editable", **diag)`.
      if (probe) this.dbg("set-editable", probe);
      return (probe as { ok: boolean; reason?: string; method?: string } | null);
    } catch (e) {
      this.dbg("set-editable", { ok: false, reason: "exception", error: String((e as Error).message ?? e) });
      return { ok: false, reason: "exception" };
    }
  }

  /**
   * Live read-back after a `page.keyboard.type()` fallback. Parity with
   * Python `_verify_typed_value` (`client.py:3318`). Returns the actual
   * value seen on the DOM (or null if the element vanished); always
   * emits a `dbg("keyboard-verify", …)` line so silent TYPE failures
   * are visible in debug mode.
   */
  private async verifyTypedValue(
    page: AliaxPage,
    stamp: string | null,
    expected: string,
    label: string = "keyboard-verify",
  ): Promise<string | null> {
    if (!stamp) return null;
    try {
      // Three-tier read-back — exact port of Python `client.py:3318`:
      //   (1) stamped element itself,
      //   (2) descendant `<input>`/`<textarea>` (for label-wrapped inputs
      //       where the stamp sits on the <label>),
      //   (3) `document.activeElement` with shadow-DOM traversal (for
      //       custom-element/web-component editors).
      const got = await this.safeEval<string | null>(
        page,
        `({s}) => {
          const tgt = s ? document.querySelector('[data-aliax-id="' + String(s) + '"]') : null;
          const pick = (el) => {
            if (!el) return null;
            const t = (el.tagName || '').toUpperCase();
            if (t === 'INPUT' || t === 'TEXTAREA') return String(el.value);
            if (el.isContentEditable) return String(el.textContent || '');
            return null;
          };
          let v = pick(tgt);
          if (v !== null) return v;
          if (tgt) {
            const inner = tgt.querySelector && tgt.querySelector('input:not([type="hidden"]), textarea');
            v = pick(inner);
            if (v !== null) return v;
          }
          let a = document.activeElement;
          while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
          return pick(a);
        }`,
        { s: String(stamp) },
      );
      const value = typeof got === "string" ? got : null;
      const ok = value != null && value === String(expected);
      this.dbg(label, {
        stamp,
        ok,
        expected,
        got: value,
      });
      return value;
    } catch (e) {
      this.dbg("verify.exception", {
        stamp,
        error: String((e as Error).message ?? e),
      });
      this.dbg(label, {
        stamp,
        ok: false,
        expected,
        got: null,
        error: String((e as Error).message ?? e),
      });
      return null;
    }
  }

  /* ----------------------------- SCROLL ----------------------------- */

  private async handleScroll(
    page: AliaxPage,
    decision: Decision,
    axis: "x" | "y" | null,
    sign: 1 | -1,
    result: ExecuteResult,
  ): Promise<void> {
    const elementId =
      (decision.element_id as string | undefined) ??
      (decision.id as string | undefined);
    const stamp = stampFromId(elementId);
    const dxRaw = (decision.dx ?? decision.delta_x) as number | undefined;
    const dyRaw = (decision.dy ?? decision.delta_y) as number | undefined;

    let scrolled = false;

    // (a) Targeted container scroll via DNA stamp.
    if (stamp && dxRaw == null && dyRaw == null) {
      const safe = cssAttrEscape(stamp);
      try {
        const probe = await this.safeEval<{
          ok: boolean;
          moved?: boolean;
          dx?: number;
          dy?: number;
        }>(
          page,
          `({s, axis, sign}) => {
            const el = document.querySelector('[data-aliax-id="' + s + '"]');
            if (!el) return {ok:false, reason:'no-node'};
            const before = {x: el.scrollLeft, y: el.scrollTop};
            const dy = (axis === 'y' || !axis) ? (sign||1) * Math.max(80, el.clientHeight * 0.8) : 0;
            const dx = (axis === 'x')          ? (sign||1) * Math.max(80, el.clientWidth  * 0.8) : 0;
            el.scrollBy({left: dx, top: dy, behavior: 'instant'});
            const moved = (el.scrollLeft !== before.x) || (el.scrollTop !== before.y);
            return {ok:true, moved, dx, dy};
          }`,
          { s: safe, axis: axis ?? "y", sign: sign ?? 1 },
        );
        if (probe?.ok) {
          if (probe.moved) {
            scrolled = true;
            result.target = elementId;
            result.scroll = [Math.round(probe.dx ?? 0), Math.round(probe.dy ?? 0)];
          }
          // If not moved — container hit its scroll limit, fall through to window.
        }
      } catch {
        /* fall through */
      }
    }

    // (b) Explicit window delta.
    if (!scrolled && (dxRaw != null || dyRaw != null)) {
      const dx = dxRaw ?? 0;
      const dy = dyRaw ?? 0;
      await this.safeEval(
        page,
        "({dx, dy}) => window.scrollBy({left: dx, top: dy, behavior: 'instant'})",
        { dx, dy },
      );
      result.scroll = [dx, dy];
      scrolled = true;
    }

    // (c) Directional fallback / panic scroll.
    if (!scrolled) {
      const ax = axis ?? "y";
      const sg = sign ?? 1;
      await this.safeEval(
        page,
        `({axis, sign}) => {
          const dy = axis === 'y' ? sign * Math.floor(window.innerHeight * 0.8) : 0;
          const dx = axis === 'x' ? sign * Math.floor(window.innerWidth  * 0.8) : 0;
          window.scrollBy({left: dx, top: dy, behavior: 'instant'});
        }`,
        { axis: ax, sign: sg },
      );
      result.scroll = ax === "y" ? [0, sg * 800] : [sg * 600, 0];
    }
    this.lastMapByPage.delete(page);
    result.ok = true;
  }

  /* ------------------------------ COMBO ------------------------------ */

  private async handleCombo(
    page: AliaxPage,
    decision: Decision,
    typeDelay: number,
    result: ExecuteResult,
  ): Promise<void> {
    const actions = decision.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      result.error = "COMBO requires `actions`: a list of 1-2 sub-action dicts.";
      return;
    }
    if (actions.length > 2) {
      result.error = "COMBO violation: maximum of 2 sequential actions per turn.";
      return;
    }
    const completed: Array<Record<string, unknown>> = [];
    let comboOk = true;
    let failReason: string | null = null;
    let failStep: number | null = null;
    for (let i = 0; i < actions.length; i++) {
      const sub = actions[i];
      // Type-guard: each sub-action MUST be a Mapping (parity with
      // Python `isinstance(sub, Mapping)`). Catches the LLM emitting
      // `{actions: ["CLICK", "el_1"]}` before reading `.action`, which
      // would otherwise dispatch as an unknown verb with a less
      // informative error.
      if (!sub || typeof sub !== "object") {
        comboOk = false;
        failStep = i + 1;
        failReason = `step ${i + 1} is not an action object`;
        break;
      }
      const subRaw = String(sub.action ?? "").toUpperCase();
      if (subRaw === "COMBO") {
        comboOk = false;
        failStep = i + 1;
        failReason = `step ${i + 1}: nested COMBO is not allowed`;
        break;
      }
      let stepResult: ExecuteResult;
      try {
        stepResult = await this.execute(page, sub, { typeDelayMs: typeDelay });
      } catch (e) {
        stepResult = {
          ok: false,
          action: subRaw,
          error: (e as Error).message ?? String(e),
        };
      }
      completed.push({
        step: i + 1,
        action: stepResult.action ?? subRaw,
        ok: !!stepResult.ok,
        element_id: stepResult.element_id,
        execution_tier: stepResult.execution_tier,
        error: stepResult.error,
      });
      if (!stepResult.ok) {
        comboOk = false;
        failStep = i + 1;
        failReason =
          stepResult.error ?? `step ${i + 1} (${subRaw}) failed`;
        break;
      }
      // ~200ms DOM-settle beat between steps.
      // CDP-aware ~200ms DOM-settle beat between steps (parity with
      // Python `page.wait_for_timeout(200)`). Fall back to a bare timer
      // if the runtime page lacks `waitForTimeout` (older Playwright).
      if (i < actions.length - 1) {
        if (typeof page.waitForTimeout === "function") {
          await page.waitForTimeout(200).catch(() => sleep(200));
        } else {
          await sleep(200);
        }
      }
    }
    result.completed_steps = completed;
    if (comboOk) {
      result.ok = true;
      result.status = "success";
    } else {
      result.ok = false;
      result.status = "partial_success";
      result.failed_at_step = failStep ?? undefined;
      result.error = failReason ?? "combo aborted";
    }
  }

  /* ---------------------------- BATCH_TYPE ---------------------------- */

  private async handleBatchType(
    page: AliaxPage,
    decision: Decision,
    typeDelay: number,
    result: ExecuteResult,
  ): Promise<void> {
    const inputs = decision.inputs;
    if (!Array.isArray(inputs) || inputs.length === 0) {
      result.error =
        "BATCH_TYPE requires `inputs`: a non-empty list of {element_id, value} entries.";
      return;
    }
    const filled: Array<Record<string, unknown>> = [];
    let batchOk = true;
    let failId: string | undefined;
    let failReason: string | null = null;
    for (let i = 0; i < inputs.length; i++) {
      const task = inputs[i];
      // Parity with Python `client.py:2141`: an LLM may emit
      // `{inputs: ["el_1","el_2"]}` (strings) instead of objects. Catch
      // that EXACT shape with a precise error so self-correction prompts
      // get the right hint, not the misleading "missing element_id".
      if (!task || typeof task !== "object") {
        batchOk = false;
        failReason = `input[${i}] is not an object`;
        break;
      }
      const elId = (task.element_id ?? task.id) as string | undefined;
      const val = decisionText(task as Decision);
      const stamp = stampFromId(elId);
      if (!stamp) {
        batchOk = false;
        failId = elId;
        failReason = `input[${i}] missing element_id`;
        break;
      }
      const cached = this.cachedRecord(page, elId);
      const r = await this.actViaLocator(
        page,
        stamp,
        "TYPE",
        { action: "TYPE", element_id: elId, value: val },
        cached,
        typeDelay,
      ).catch((e) => ({ ok: false, extra: { error: String(e) } as Record<string, unknown> }));
      if (!r.ok) {
        batchOk = false;
        failId = elId;
        failReason =
          (r.extra.error as string | undefined) ??
          `failed to type into ${elId} (locator path rejected; element may be hidden or non-editable)`;
        break;
      }
      filled.push({
        element_id: elId,
        value: val,
        execution_tier: r.extra.execution_tier,
      });
    }
    result.filled = filled;
    if (batchOk) {
      result.ok = true;
      result.status = "success";
    } else {
      result.ok = false;
      result.status = "partial_success";
      result.error = failReason ?? "batch aborted";
      if (failId) result.element_id = failId;
    }
  }

  /* --------------------- get_element_coords helper --------------------- */

  /**
   * Re-resolve `{x, y, width, height}` for `elementId` through the
   * bundled mapper. Useful for orchestrators wanting to hit-test cached
   * coordinates without re-running a full `parseUi`. Returns `null`
   * when the element is no longer in the DOM.
   */
  async getElementCoords(
    page: AliaxPage,
    elementId: string,
  ): Promise<{ x: number; y: number; width?: number; height?: number } | null> {
    const already = await page
      .evaluate<boolean>("typeof window.__AliaxCore !== 'undefined'")
      .catch(() => false);
    if (!already) await this.safeInject(page);
    return this.safeEval(
      page,
      "(id) => window.__AliaxCore.resolveElement(id)",
      elementId,
    );
  }

  /* ----------------------------- internals ----------------------------- */

  private cachedRecord(
    page: AliaxPage,
    elementId: string | undefined,
  ): MappedElement | null {
    if (!elementId) return null;
    const cached = this.lastMapByPage.get(page);
    return cached?.find((e) => e.element_id === elementId) ?? null;
  }

  private async coordsFor(
    page: AliaxPage,
    decision: Decision,
  ): Promise<{ x: number; y: number; element_id?: string } | null> {
    if (decision.x != null && decision.y != null) {
      return { x: Number(decision.x), y: Number(decision.y) };
    }
    const elementId =
      (decision.element_id as string | undefined) ??
      (decision.id as string | undefined);
    if (!elementId) return null;
    const cached = this.cachedRecord(page, elementId);
    if (cached?.bounds) {
      return {
        x: cached.bounds.x + cached.bounds.width / 2,
        y: cached.bounds.y + cached.bounds.height / 2,
        element_id: elementId,
      };
    }
    const resolved = await this.getElementCoords(page, elementId).catch(() => null);
    if (!resolved) return null;
    return { x: Number(resolved.x), y: Number(resolved.y), element_id: elementId };
  }

  /* ============================ reportIssue ============================ */

  /**
   * Unified escalation entrypoint. Strict Gatekeeper: rejects unless
   * (a) 3 identical state hashes (frozen DOM) OR (b) a period-2/3/4
   * action cycle with distinct members per period (so legitimate
   * "Load More" repeats don't escalate). On rejection returns
   * `{ ok: false, status: "rejected", gatekeeper: "rejected", msg }`
   * with parity-preserving wording. On acceptance posts a multipart
   * capture and clears the failure history.
   *
   * @param opts.force  Bypass the Gatekeeper — developer asserts only.
   */
  async reportIssue(
    page: AliaxPage,
    opts: ReportIssueOptions,
  ): Promise<ExecuteResult> {
    const { eligible, reason: gateReason } = this.failureProof(page);
    if (!eligible && !opts.force) {
      return {
        ok: false,
        status: "rejected",
        capture_id: null,
        msg: Aliax.REPORT_REJECT_MSG,
        message: Aliax.REPORT_REJECT_MSG,
        gatekeeper: "rejected",
        evidence: {
          state_history_len: (this.stateHistoryByPage.get(page) ?? []).length,
          action_history_len: (this.actionHistoryByPage.get(page) ?? []).length,
        },
      };
    }
    const ctx: Record<string, unknown> = {
      trigger: opts.force
        ? "developer_assert_force"
        : `gatekeeper:${gateReason ?? "forced"}`,
      reason: opts.reason,
    };
    if (opts.expectedOutcome)
      ctx.expected_outcome = String(opts.expectedOutcome).slice(0, 500);
    if (opts.actualOutcome)
      ctx.actual_outcome = String(opts.actualOutcome).slice(0, 500);

    const result = await this.captureFailure(page, {
      goal: (opts.goal || opts.reason || "Agent escalation").trim() ||
        "Agent escalation",
      thoughts: opts.thoughts,
      lastAttemptedAction: opts.lastAttemptedAction,
      failureReason: opts.reason || gateReason || "agent_stuck",
      step: opts.step,
      context: ctx,
    });

    if (result.status === "success") this.resetFailureHistory(page);
    // Mirror Python `client.py:2738`: spread the full captureFailure dict
    // (preserving `screenshot_url`, `idempotent_replay`, `debug_payload_path`),
    // then `setdefault('gatekeeper', …)` and overwrite `ok`. No `action`
    // key — Python doesn't set one and orchestrators must not branch on it.
    const existingGatekeeper = (result as unknown as Record<string, unknown>).gatekeeper;
    return {
      ...result,
      gatekeeper:
        (typeof existingGatekeeper === "string" ? existingGatekeeper : undefined) ??
        gateReason ??
        (opts.force ? "forced" : "allowed"),
      ok: result.status === "success",
    };
  }

  /* =========================== captureFailure =========================== */

  /**
   * Multipart-POST a failure snapshot (screenshot + spatial map +
   * thoughts + last attempted action) to `/v1/capture`. Implements the
   * full retry contract: idempotency UUID, 3 attempts with linear
   * backoff on 429/502/503/504, one-shot `workers.dev` failover on
   * true connect errors. Never throws — failures land in
   * `result.status: "error"`.
   *
   * In `debugMode`, no network call is made — instead the JSON payload
   * and JPEG are written to `os.tmpdir()` and returned via
   * `debug_payload_path` / `screenshot_url`.
   */
  async captureFailure(
    page: AliaxPage,
    opts: CaptureFailureOptions,
  ): Promise<CaptureFailureResult> {
    if (page.waitForLoadState) {
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    }
    await this.safeInject(page);

    const selectorsJson = JSON.stringify(this.redactSelectors);
    let shot: Buffer = Buffer.alloc(0);
    let spatialMap: MappedElement[] = [];
    let viewport: Viewport = defaultViewport();
    // Parity with Python `capture_failure` (`client.py:2776`): the flag
    // starts `false` and only flips to `true` AFTER `blurPII()` returns. If
    // injection itself throws (mapper not loaded, wrong frame), the
    // `finally` correctly skips unblur — Python's conservative pattern.
    // The optimistic-true pattern is only correct in `parseUiOnce` where
    // partial blur mid-loop is possible.
    let blurred = false;

    try {
      await this.safeEval(page, `() => window.__AliaxCore.blurPII(${selectorsJson})`);
      blurred = true;
      shot = await page.screenshot({ type: "jpeg", quality: 85 });
      const dom = await this.safeEval(
        page,
        "(o) => window.__AliaxCore.mapDOM(o)",
        { redact_text_for_pii: true, pii_selectors: this.redactSelectors, __t: this.nextMapperTicket() },
      );
      const unpacked = unpackDomResult(dom);
      spatialMap = unpacked.elements;
      viewport = unpacked.viewport;
    } finally {
      if (blurred) {
        // Single-attempt unblur with warn-on-fail — parity with Python
        // `client.py:2824` which logs `unblurPII failed` and moves on
        // without a retry (capture pipeline already has its own retry).
        const unblurJs =
          "() => { if (window.__AliaxCore) window.__AliaxCore.unblurPII(); }";
        try {
          await this.safeEval(page, unblurJs);
        } catch (e1) {
          console.warn(
            "[Aliax] unblurPII failed in captureFailure:",
            (e1 as Error).message,
          );
        }
      }
    }

    const dpr = Number.isFinite(viewport.dpr) && viewport.dpr > 0 ? viewport.dpr : 1;
    // Width/height resolution order — exact parity with Python
    // `client.py:2845`: (1) parse the screenshot header bytes and divide
    // by dpr (most accurate on retina); (2) `page.viewportSize()` only
    // (browser truth, not the mapper struct which may be stale after
    // an unobserved resize); (3) 1280×800 hardcoded fallback.
    const vp = page.viewportSize();
    const parsedDims = imageDimensions(shot);
    let width: number;
    let height: number;
    if (parsedDims && dpr > 0) {
      width = Math.round(parsedDims[0] / dpr);
      height = Math.round(parsedDims[1] / dpr);
    } else if (vp) {
      width = vp.width;
      height = vp.height;
    } else {
      width = 1280;
      height = 800;
    }

    const captureUrl = (() => {
      try {
        return page.url();
      } catch {
        return "";
      }
    })();
    const capturePath = captureUrl
      ? (() => {
          try {
            return new URL(captureUrl).pathname || "";
          } catch {
            return "";
          }
        })()
      : "";
    let captureTitle = "";
    try {
      const t = await page.title();
      if (typeof t === "string") captureTitle = t.trim().slice(0, 200);
    } catch {
      captureTitle = "";
    }

    const contextStr =
      opts.context == null
        ? ""
        : typeof opts.context === "string"
          ? opts.context
          : JSON.stringify(opts.context);

    const payload: Record<string, string> = {
      goal: opts.goal,
      context: contextStr,
      viewport: JSON.stringify({ width, height, dpr }),
      spatial_map: JSON.stringify(spatialMap),
      sdk_version: SDK_VERSION,
    };
    if (captureUrl) payload.page_url = captureUrl.slice(0, 500);
    if (capturePath) payload.page_path = capturePath.slice(0, 200);
    if (captureTitle) payload.page_title = captureTitle;
    if (opts.thoughts) payload.ai_thoughts = String(opts.thoughts);
    const action = coerceAction(opts.lastAttemptedAction);
    if (action) payload.last_attempted_action = JSON.stringify(action);
    if (opts.failureReason) payload.failure_reason = String(opts.failureReason);
    if (opts.step != null) payload.step = String(Math.trunc(opts.step));

    if (this.debugMode) {
      const { tmpdir } = await import("node:os");
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = tmpdir();
      const shotPath = join(dir, "aliax_debug_screenshot.jpg");
      const payloadPath = join(dir, "aliax_debug_payload.json");
      try { writeFileSync(shotPath, shot); } catch { /* ignore */ }
      try {
        writeFileSync(
          payloadPath,
          JSON.stringify(
            {
              ...payload,
              spatial_map: spatialMap,
              viewport: { width, height, dpr },
              last_attempted_action: action,
              screenshot_url: shotPath,
            },
            null,
            2,
          ),
        );
      } catch { /* ignore */ }
      return {
        status: "success",
        capture_id: `debug_capture_${randomUUID().slice(0, 8)}`,
        screenshot_url: shotPath,
        // Parity with Python: surface the on-disk JSON path so the
        // orchestrator can show "wrote X" without re-deriving the dir.
        debug_payload_path: payloadPath,
        msg: `Debug mode: wrote payload + screenshot to ${dir}`,
      };
    }

    await this.ensureKey();
    const idempotency = randomUUID();

    let lastStatus: number | null = null;
    let lastErr: string | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = new FormData();
        for (const [k, v] of Object.entries(payload)) fd.set(k, v);
        fd.set(
          "screenshot",
          new Blob([new Uint8Array(shot)], { type: "image/jpeg" }),
          "screenshot.jpg",
        );
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 15_000);
        let res: Response;
        try {
          res = await fetch(this.url("capture"), {
            method: "POST",
            headers: this.authHeaders({ "X-Idempotency-Key": idempotency }),
            body: fd,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(t);
        }
        lastStatus = res.status;
        let body: unknown = null;
        try { body = await res.json(); } catch { body = null; }
        if (res.status === 200 || res.status === 201) {
          const b = (body ?? {}) as Record<string, unknown>;
          const isReplay = !!b.idempotent_replay;
          if (!isReplay) {
            this.telemetryInBackground("capture_failure", 1, {
              goal: opts.goal.slice(0, 120),
              failure_reason: opts.failureReason ?? "",
              path: capturePath.slice(0, 120),
              title: captureTitle.slice(0, 120),
            });
          }
          return {
            status: "success",
            capture_id: (b.capture_id as string) ?? null,
            screenshot_url: b.screenshot_url as string | undefined,
            idempotent_replay: isReplay,
            msg: "Failure snapshot queued for annotation.",
          };
        }
        if ([429, 502, 503, 504].includes(res.status) && attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (res.status === 401 || res.status === 402) {
          this.absorbBillingResponse(res.status, body, "capture_failure");
        }
        return {
          status: "error",
          capture_id: null,
          msg: `Failed with status code: ${res.status}`,
        };
      } catch (e) {
        lastErr = (e as Error).name ?? "Error";
        const networkish = isConnectError(e) || /timeout|aborted/i.test(String((e as Error).message ?? ""));
        // Only fail over on a TRUE network/connect error — not on plain
        // timeouts or JS-level TypeErrors. Otherwise a transient JSON
        // serialisation bug would corrupt the fallback latch and pin
        // every subsequent call to workers.dev for the process lifetime.
        if (attempt === 0 && isConnectError(e) && this.maybeSwapToFallback())
          continue;
        if (attempt < 2) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        // Parity with Python `client.py:3027/3034`: network errors keep
        // the exception name in parens (operators can diagnose DNS vs
        // TCP vs timeout); unexpected JS-level errors get a clean message
        // (the stack lands in debugMode logs separately).
        return {
          status: "error",
          capture_id: null,
          msg: networkish
            ? `Network error contacting Aliax API (${lastErr}).`
            : "Unexpected error contacting Aliax API.",
        };
      }
    }
    return {
      status: "error",
      capture_id: null,
      msg: `Failed after retries (status=${lastStatus}, err=${lastErr}).`,
    };
  }
}

/* ===================== ParseContext (output DTO) ===================== */

export interface ParseContextInit {
  imageBytes: Buffer;
  imageMime: string;
  imageSize: [number, number];
  elements: MappedElement[];
  viewport: Viewport;
  url: string;
  path: string;
  title: string;
  truncated: boolean;
  render: ResolvedRender;
}

/**
 * Output DTO from {@link Aliax.parseUi}. Carries the Set-of-Mark
 * screenshot, the structured element list, viewport metadata, and
 * helpers to assemble the VLM prompt block.
 *
 * Always check `truncated` before sending to the VLM — when `true`,
 * the mapper hit `maxElements` and the `elements` list is incomplete.
 * The LLM will be told via {@link llmTextBlock} (a `[truncated]` line
 * is appended automatically), but you should consider bumping
 * `maxElements` or issuing a SCROLL to reveal the hidden region.
 */
export class ParseContext {
  /** Raw JPEG/PNG bytes — pass directly to your VLM as an image input. */
  imageBytes: Buffer;
  /** `"image/jpeg"` or `"image/png"`. */
  imageMime: string;
  /** Pixel dimensions of `imageBytes` as `[width, height]`. */
  imageSize: [number, number];
  /** Interactable elements found by the mapper. Stable `element_id` across re-renders. */
  elements: MappedElement[];
  /** CSS-pixel viewport + scroll state + dpr at parse time. */
  viewport: Viewport;
  /** Full page URL at parse time. */
  url: string;
  /** Just the pathname (no host, no query). */
  path: string;
  /** Trimmed document title (≤200 chars). */
  title: string;
  /** True iff the element list was truncated at `maxElements`. */
  truncated: boolean;
  /** Resolved render config — what was actually used (post-clamp). */
  render: ResolvedRender;

  constructor(init: ParseContextInit) {
    this.imageBytes = init.imageBytes;
    this.imageMime = init.imageMime;
    this.imageSize = init.imageSize;
    this.elements = init.elements;
    this.viewport = init.viewport;
    this.url = init.url;
    this.path = init.path;
    this.title = init.title;
    this.truncated = init.truncated;
    this.render = init.render;
  }

  /** All `element_id`s present in the current map — useful for caller-side validation that the LLM didn't hallucinate an id. */
  get elementIds(): string[] {
    return this.elements.map((e) => e.element_id).filter((x): x is string => !!x);
  }

  /** Pre-formatted navigation/route header (Page Title, Active Route, Scrollability) — drop at the top of your VLM user message. */
  routeContextBlock(): string {
    const lines = ["=== CURRENT BROWSER STATE ==="];
    if (this.title) lines.push(`- Page Title: "${this.title}"`);
    if (this.path) lines.push(`- Active Route: ${this.path}`);
    if (this.url) lines.push(`- Full URL: ${this.url}`);
    const psy = !!this.viewport.page_scrollable_y;
    const psx = !!this.viewport.page_scrollable_x;
    if (psy && psx) lines.push("- Page Scroll: vertical + horizontal");
    else if (psy) lines.push("- Page Scroll: vertical");
    else if (psx) lines.push("- Page Scroll: horizontal");
    else
      lines.push(
        "- Page Scroll: none (target a scrollable container by element_id)",
      );
    lines.push("=============================");
    return lines.join("\n");
  }

  /** Human-readable element listing (one element per line, with state tags) — drop into the VLM user message. Automatically appends a `[truncated]` notice when {@link truncated} is true. */
  llmTextBlock(): string {
    const out: string[] = [];
    for (const e of this.elements) {
      const eid = e.element_id;
      const tag = e.tag;
      const text = (e.text ?? "").trim();
      const extra: string[] = [];
      if (e.editable) extra.push("editable");
      if (e.is_canvas) extra.push("CANVAS");
      const st = e.state ?? {};
      if (st.disabled) extra.push("DISABLED");
      if (st.busy) extra.push("BUSY");
      if (st.invalid) extra.push("INVALID");
      if (st.required) extra.push("REQUIRED");
      if (st.readonly) extra.push("READONLY");
      if (st.checked === true) extra.push("CHECKED");
      else if (st.checked === "mixed") extra.push("MIXED");
      else if (st.checked === false) extra.push("UNCHECKED");
      if (st.selected) extra.push("SELECTED");
      if (st.pressed === true) extra.push("PRESSED");
      else if (st.pressed === false) extra.push("UNPRESSED");
      if (st.expanded === true) extra.push("EXPANDED");
      else if (st.expanded === false) extra.push("COLLAPSED");
      if (st.scrollable_y && st.scrollable_x) extra.push("SCROLLABLE");
      else if (st.scrollable_y) extra.push("SCROLLABLE_Y");
      else if (st.scrollable_x) extra.push("SCROLLABLE_X");
      const tail = extra.length ? ` [${extra.join(",")}]` : "";
      const base = text ? `${eid} ${tag}${tail}: ${text}` : `${eid} ${tag}${tail}`;
      out.push(e.links_to ? `${base} -> ${e.links_to}` : base);
    }
    if (this.truncated)
      out.push(
        "[truncated] DOM mapper hit its element cap — additional " +
          "interactable elements exist but are not listed.",
      );
    return out.join("\n");
  }
}

/* --------------------------- shared helpers --------------------------- */

function defaultViewport(): Viewport {
  return { width: 0, height: 0, dpr: 1, scroll_x: 0, scroll_y: 0 };
}
function unpackDomResult(d: unknown): {
  elements: MappedElement[];
  viewport: Viewport;
  truncated: boolean;
} {
  if (Array.isArray(d))
    return { elements: d as MappedElement[], viewport: defaultViewport(), truncated: false };
  if (d && typeof d === "object") {
    const r = d as Record<string, unknown>;
    return {
      elements: Array.isArray(r.elements) ? (r.elements as MappedElement[]) : [],
      viewport: { ...defaultViewport(), ...((r.viewport as Viewport) ?? {}) },
      truncated: !!r.truncated,
    };
  }
  return { elements: [], viewport: defaultViewport(), truncated: false };
}

/**
 * Inline React-friendly value writer. Kept as a template literal so the
 * SDK has zero playwright `addScriptTag` / source-map shenanigans. Same
 * function body as Python `_set_plain_editable_value` so behaviour is
 * identical across SDKs.
 */
const REACT_TYPE_FN = `async ({s, v}) => {
  // diag carries the full Python \`_set_plain_editable_value\` field set so
  // debugMode operators can pinpoint TYPE failures down to the resolved
  // candidate, the focused element, and the value transition.
  const diag = {
    plain: false, ok: false, reason: null, stamp: s, requested: String(v),
    stampResolved: false, stampTag: null, stampDisabled: null, stampReadOnly: null,
    activeTag: null, activeIsBody: null, focusedAfterFocus: null,
    valueBefore: null, valueAfter: null,
    elTag: null, elType: null,
    candidateSource: null, candidatesTried: 0,
    method: null,
  };
  const target = s ? document.querySelector('[data-aliax-id="' + String(s) + '"]') : null;
  if (target) {
    diag.stampResolved = true;
    try { diag.stampTag = (target.tagName || '').toUpperCase(); } catch (_) {}
    try { diag.stampDisabled = !!target.disabled; } catch (_) {}
    try { diag.stampReadOnly = !!target.readOnly; } catch (_) {}
  }
  const badInputTypes = new Set(['button','submit','reset','image','checkbox','radio','file','hidden']);
  const isPlain = (el) => {
    if (!el || !el.tagName || el.isContentEditable) return false;
    const tag = el.tagName.toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    if (el.disabled || el.readOnly) return false;
    if (tag === 'INPUT' && badInputTypes.has(String(el.type || '').toLowerCase())) return false;
    return true;
  };
  const deepActive = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };
  const active = deepActive();
  try { diag.activeTag = active && active.tagName ? active.tagName.toUpperCase() : null; } catch (_) {}
  try { diag.activeIsBody = !!(active && active.tagName && active.tagName.toUpperCase() === 'BODY'); } catch (_) {}
  const candidates = [];
  const sources = [];
  const add = (el, src) => {
    if (isPlain(el) && !candidates.includes(el)) { candidates.push(el); sources.push(src); }
  };
  add(target, 'target');
  try { if (target && target.control) add(target.control, 'label.control'); } catch (_) {}
  try {
    if (target && target.getAttribute) {
      const id = target.getAttribute('for') || target.getAttribute('aria-controls');
      if (id) add(document.getElementById(id), 'for/aria-controls');
    }
  } catch (_) {}
  try { if (target && target.querySelector) add(target.querySelector('input:not([type="hidden"]), textarea'), 'descendant'); } catch (_) {}
  try {
    // Parity with Python \`client.py:3227\`: accept the activeElement when
    // it equals \`target.control\` (label-for-input pattern where the
    // <input> gets focus programmatically while the stamp is on the <label>).
    if (isPlain(active) && (!target || active === target || target.contains(active) || (target.control && active === target.control))) add(active, 'activeElement');
  } catch (_) { if (!target) add(active, 'activeElement'); }
  // Python \`client.py:3231\` assigns the full sources[] Array so debug
  // tooling can see WHICH candidates were tried, not just how many.
  diag.candidatesTried = sources;
  const el = candidates[0];
  if (!el) { diag.reason = 'no editable candidate'; return diag; }
  diag.plain = true;
  diag.candidateSource = sources[0] || null;
  try { diag.elTag = (el.tagName || '').toUpperCase(); } catch (_) {}
  try { diag.elType = String(el.type || ''); } catch (_) {}
  try { diag.valueBefore = String(el.value == null ? '' : el.value); } catch (_) {}

  const fireInput = (type, init) => {
    try { el.dispatchEvent(new InputEvent(type, Object.assign({ bubbles: true, composed: true }, init || {}))); }
    catch (_) { el.dispatchEvent(new Event(type, { bubbles: true, composed: true })); }
  };
  const fireKey = (type) => {
    try { el.dispatchEvent(new KeyboardEvent(type, { bubbles: true, composed: true, key: 'Unidentified' })); } catch (_) {}
  };
  const nativeSet = (val) => {
    const proto = Object.getPrototypeOf(el);
    const protoSetter = proto && Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    const ownSetter = Object.getOwnPropertyDescriptor(el, 'value') && Object.getOwnPropertyDescriptor(el, 'value').set;
    if (protoSetter && protoSetter !== ownSetter) protoSetter.call(el, val);
    else if (ownSetter) ownSetter.call(el, val);
    else el.value = val;
  };
  const settle = () => new Promise((resolve) => {
    const done = () => setTimeout(resolve, 35);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
    else done();
  });

  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
  try { diag.focusedAfterFocus = deepActive() === el; } catch (_) {}
  try { if (typeof el.select === 'function') el.select(); } catch (_) {}

  let method = 'native-setter';
  try {
    nativeSet('');
    fireInput('input', { inputType: 'deleteContentBackward', data: null });
    try { if (typeof el.select === 'function') el.select(); } catch (_) {}
    if (document.execCommand) {
      const usedExec = document.execCommand('insertText', false, String(v));
      if (usedExec || String(el.value) === String(v)) method = 'execCommand';
    }
  } catch (_) {}

  if (String(el.value) !== String(v)) {
    fireKey('keydown');
    fireKey('keypress');
    fireInput('beforeinput', { cancelable: true, inputType: 'insertReplacementText', data: String(v) });
    nativeSet(String(v));
    fireInput('input', { inputType: 'insertReplacementText', data: String(v) });
    fireKey('keyup');
  }
  el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} }
  await settle();
  diag.method = method;
  try { diag.valueAfter = String(el.value == null ? '' : el.value); } catch (_) {}
  diag.ok = String(el.value) === String(v);
  if (!diag.ok) diag.reason = 'value mismatch after write';
  return diag;
}`;

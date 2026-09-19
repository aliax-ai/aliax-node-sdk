import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Node SDK smoke tests — 1:1 mirror of aliax-python-sdk/tests/test_client.py
 * plus extra unit coverage for the render normaliser, image-dimension
 * parsers, prompts module, mapper asset, and error hierarchy.
 *
 * Run via `npm run build && npm test` from vendor/aliax-sdk/aliax-node-sdk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import * as aliaxAll from "../index.js";
import {
  Aliax,
  AliaxConfigError,
  AliaxError,
  AliaxInvalidKeyError,
  AliaxOutOfCreditsError,
  ALIAX_SYSTEM_INSTRUCTIONS,
  SDK_VERSION,
  SYSTEM_INSTRUCTIONS,
  AttemptedAction,
} from "../index.js";
import {
  jpegDimensions,
  pngDimensions,
  imageDimensions,
  normaliseRenderConfig,
} from "../render.js";

/* ------------------------------------------------------------------ */
/* Mirror of test_client.py                                             */
/* ------------------------------------------------------------------ */

test("version is exported and looks like semver", () => {
  const c = new Aliax({ apiKey: "sk_test_ver", checkForUpdates: false });
  assert.equal(typeof c.sdkVersion, "string");
  assert.ok(c.sdkVersion.split(".").length >= 3, "expected semver-ish version");
});

test("public surface resolves", () => {
  const expected = [
    "Aliax",
    "ParseContext",
    "AliaxError",
    "AliaxInvalidKeyError",
    "AliaxOutOfCreditsError",
    "ALIAX_SYSTEM_INSTRUCTIONS",
    "SYSTEM_INSTRUCTIONS",
    "AttemptedAction",
  ];
  for (const name of expected) {
    assert.ok(
      (aliaxAll as Record<string, unknown>)[name] !== undefined,
      `missing public symbol: ${name}`,
    );
  }
});

test("exception hierarchy", () => {
  const oc = new AliaxOutOfCreditsError(0);
  const ik = new AliaxInvalidKeyError("revoked_api_key");
  assert.ok(oc instanceof AliaxError);
  assert.ok(ik instanceof AliaxError);
  assert.ok(oc instanceof Error);
  assert.equal(oc.name, "AliaxOutOfCreditsError");
  assert.equal(ik.name, "AliaxInvalidKeyError");
  assert.equal(ik.reason, "revoked_api_key");
  assert.equal(oc.balance, 0);
});

test("AliaxOutOfCreditsError balance defaults to null and message is human", () => {
  const e = new AliaxOutOfCreditsError();
  assert.equal(e.balance, null);
  assert.match(e.message, /unknown/);
  assert.match(e.message, /aliax\.xyz/);
});

test("missing key throws when the anonymous sandbox is opted out", () => {
  delete process.env.ALIAX_API_KEY;
  assert.throws(
    () => new Aliax({ checkForUpdates: false, allowAnonymous: false }),
    /API key/,
  );
  assert.throws(
    () =>
      new Aliax({
        apiKey: undefined,
        checkForUpdates: false,
        allowAnonymous: false,
      }),
    /API key/,
  );
});

test("missing key defers to the free anonymous sandbox by default", () => {
  delete process.env.ALIAX_API_KEY;
  process.env.ALIAX_CREDENTIALS_PATH = join(
    mkdtempSync(join(tmpdir(), "aliax-anon-")),
    "credentials",
  );
  // No throw: the credential is minted lazily on the first network call.
  const c = new Aliax({ checkForUpdates: false, telemetry: false });
  assert.equal(c.anonymous, true);
  delete process.env.ALIAX_CREDENTIALS_PATH;
});

test("a non-sk_ key is still rejected outright", () => {
  assert.throws(
    () => new Aliax({ apiKey: "nope", checkForUpdates: false }),
    /sk_/,
  );
});

test("bad key prefix throws", () => {
  delete process.env.ALIAX_API_KEY;
  assert.throws(
    () => new Aliax({ apiKey: "not-a-real-key", checkForUpdates: false }),
    /sk_/,
  );
});

test("env var fallback (ALIAX_API_KEY)", () => {
  const prev = process.env.ALIAX_API_KEY;
  try {
    process.env.ALIAX_API_KEY = "sk_test_env_fallback_xyz";
    const c = new Aliax({ checkForUpdates: false });
    assert.equal(c.apiKey, "sk_test_env_fallback_xyz");
  } finally {
    if (prev === undefined) delete process.env.ALIAX_API_KEY;
    else process.env.ALIAX_API_KEY = prev;
  }
});

test("string-shorthand constructor accepts apiKey directly", () => {
  const c = new Aliax("sk_test_string_short" as unknown as { apiKey: string });
  assert.equal(c.apiKey, "sk_test_string_short");
});

test("encrypted dom-mapper bundled and plaintext mapper absent", () => {
  const c = new Aliax({ apiKey: "sk_test_bundle", checkForUpdates: false });
  void c; // construction alone is enough; mapper is loaded lazily
  const assets = join(dirname(fileURLToPath(import.meta.url)), "../../assets");
  const container = readFileSync(join(assets, "dom-mapper.dat"));
  assert.deepEqual(container.subarray(0, 8), Buffer.from("ALIAXM1\0", "latin1"));
  assert.ok(container.length > 60, "mapper container unexpectedly short");
  assert.equal(existsSync(join(assets, "dom-mapper.min.js")), false);
});

test("sdk version attached on instance", () => {
  const c = new Aliax({ apiKey: "sk_test_ver2", checkForUpdates: false });
  assert.equal(typeof c.sdkVersion, "string");
});

test("billingStatus initial state", () => {
  const c = new Aliax({ apiKey: "sk_test_bs", checkForUpdates: false });
  const b = c.billingStatus();
  assert.equal(b.locked, false);
  assert.equal(b.reason, null);
  assert.equal(b.balance, null);
  assert.equal(b.credits_exhausted, false);
});

test("close() is idempotent", async () => {
  const c = new Aliax({ apiKey: "sk_test_close", checkForUpdates: false });
  await c.close();
  await c.close(); // no throw
});

test("Symbol.asyncDispose works (await using parity)", async () => {
  const c = new Aliax({ apiKey: "sk_test_disp", checkForUpdates: false });
  await (c as unknown as { [Symbol.asyncDispose]: () => Promise<void> })[
    Symbol.asyncDispose
  ]();
});

test("SYSTEM_INSTRUCTIONS aliases match", () => {
  assert.equal(SYSTEM_INSTRUCTIONS, ALIAX_SYSTEM_INSTRUCTIONS);
  assert.equal(typeof ALIAX_SYSTEM_INSTRUCTIONS, "string");
  assert.ok(ALIAX_SYSTEM_INSTRUCTIONS.length > 500);
  // Sanity: both class-level and instance-level mirrors are wired.
  assert.equal((Aliax as unknown as { SYSTEM_INSTRUCTIONS: string }).SYSTEM_INSTRUCTIONS, ALIAX_SYSTEM_INSTRUCTIONS);
});

test("AttemptedAction class is constructible", () => {
  const a = new AttemptedAction({ action: "CLICK", element_id: "el_42" });
  assert.equal(a.action, "CLICK");
  assert.equal(a.element_id, "el_42");
});

/* ------------------------------------------------------------------ */
/* render.ts                                                            */
/* ------------------------------------------------------------------ */

test("normaliseRenderConfig defaults to jpeg/80", () => {
  const r = normaliseRenderConfig();
  assert.equal(r.format, "jpeg");
  assert.equal(r.quality, 80);
});

test("normaliseRenderConfig clamps quality to [30,100]", () => {
  assert.equal(normaliseRenderConfig({ quality: 10 }).quality, 30);
  assert.equal(normaliseRenderConfig({ quality: 9999 }).quality, 100);
});

test("normaliseRenderConfig accepts jpg alias", () => {
  assert.equal(normaliseRenderConfig({ format: "jpg" as never }).format, "jpeg");
});

test("normaliseRenderConfig falls back on unsupported format", () => {
  assert.equal(normaliseRenderConfig({ format: "webp" as never }).format, "jpeg");
});

test("normaliseRenderConfig honours legacy positional args", () => {
  const r = normaliseRenderConfig(undefined, "png", 55);
  assert.equal(r.format, "png");
  assert.equal(r.quality, 55);
});

test("png/jpeg dimension parsers behave", () => {
  // Minimal PNG: 8-byte sig + IHDR length(4)+'IHDR'(4)+w(4)+h(4)+... = 24+
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  assert.deepEqual(pngDimensions(png), [640, 480]);
  assert.deepEqual(imageDimensions(png), [640, 480]);

  // Minimal JPEG SOI + SOF0
  const jpeg = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x11, // segment length
    0x08,       // sample precision
    0x01, 0x90, // height = 400
    0x02, 0x80, // width  = 640
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);
  assert.deepEqual(jpegDimensions(jpeg), [640, 400]);
  assert.deepEqual(imageDimensions(jpeg), [640, 400]);

  // Garbage / truncated returns null without throwing.
  assert.equal(jpegDimensions(Buffer.from([0x00])), null);
  assert.equal(pngDimensions(Buffer.from([0x00])), null);
  assert.equal(imageDimensions(Buffer.from([0x00])), null);
});

/* ------------------------------------------------------------------ */
/* Publish-readiness regressions                                        */
/* ------------------------------------------------------------------ */

test("apiKey is not enumerable (no leak via JSON.stringify / console.log)", () => {
  const c = new Aliax({ apiKey: "sk_super_secret_token_xyz", checkForUpdates: false });
  // Runtime value still accessible to internal code.
  assert.equal(c.apiKey, "sk_super_secret_token_xyz");
  // But JSON.stringify must NOT include it.
  const dumped = JSON.stringify(c);
  assert.ok(!dumped.includes("sk_super_secret_token_xyz"),
    `apiKey leaked in JSON.stringify output: ${dumped}`);
  // And Object.keys must NOT enumerate it.
  assert.ok(!Object.keys(c).includes("apiKey"),
    "apiKey is still enumerable");
  // Property descriptor sanity.
  const d = Object.getOwnPropertyDescriptor(c, "apiKey");
  assert.equal(d?.enumerable, false);
  assert.equal(d?.writable, false);
  // `configurable` is true so a lazily-minted anonymous sandbox
  // credential (or a renewed one after 30-day expiry) can replace it.
  assert.equal(d?.configurable, true);
});

test("telemetry: false suppresses background pings and update checks", async () => {
  const calls: string[] = [];
  const origFetch = globalThis.fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = async (u: string) => {
    calls.push(String(u));
    return new Response("{}", { status: 200 });
  };
  try {
    const c = new Aliax({
      apiKey: "sk_tele_off",
      telemetry: false,
      checkForUpdates: true, // explicitly true, but telemetry:false must win
    });
    // refreshBillingStatus is the externally observable telemetry entry point.
    const s = await c.refreshBillingStatus();
    assert.ok(s);
    // Give any stray microtasks a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 0,
      `expected zero network calls, got: ${JSON.stringify(calls)}`);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("AliaxOptions accepts the telemetry flag (type smoke)", () => {
  // Pure construction smoke — exercises the new option through the type system.
  const c = new Aliax({ apiKey: "sk_smoke", telemetry: false, checkForUpdates: false });
  assert.ok(c);
});

test("ResolvedRender is re-exported from the package entry", async () => {
  const mod = await import("../index.js");
  // Type-only re-export — at runtime it's just `undefined` in the namespace,
  // but the import statement above must not throw.
  assert.ok(mod);
});

/* ------------------------------------------------------------------ */
/* 1.0.0 publish-perfection regressions                                 */
/* ------------------------------------------------------------------ */

test("SDK_VERSION is exported at module level and matches instance.sdkVersion", () => {
  assert.equal(typeof SDK_VERSION, "string");
  assert.ok(SDK_VERSION.split(".").length >= 3);
  const c = new Aliax({ apiKey: "sk_test_modversion", checkForUpdates: false });
  assert.equal(c.sdkVersion, SDK_VERSION);
});

test("bad apiKey throws AliaxConfigError (extends AliaxError)", () => {
  delete process.env.ALIAX_API_KEY;
  let caught: unknown = null;
  try {
    new Aliax({ apiKey: "not_a_real_key", checkForUpdates: false });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof AliaxConfigError, "expected AliaxConfigError");
  assert.ok(caught instanceof AliaxError, "should also extend AliaxError");
  assert.ok(caught instanceof Error);
  assert.equal((caught as Error).name, "AliaxConfigError");
});

test("AliaxConfigError is exported as a public symbol", () => {
  assert.ok((aliaxAll as Record<string, unknown>).AliaxConfigError !== undefined);
});

test("close() aborts pending fetches", async () => {
  const origFetch = globalThis.fetch;
  let abortObserved = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = (_u: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        abortObserved = true;
        reject(new Error("aborted"));
      });
    });
  try {
    const c = new Aliax({ apiKey: "sk_close_abort", checkForUpdates: false });
    const inflight = c.refreshBillingStatus();
    await new Promise((r) => setTimeout(r, 10));
    await c.close();
    await inflight;
    assert.equal(abortObserved, true, "expected the fetch to be aborted by close()");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("NAVIGATE missing-url error string matches Python parity", async () => {
  const c = new Aliax({
    apiKey: "sk_nav_str",
    checkForUpdates: false,
    telemetry: false,
  });
  const fakePage = {
    url: () => "about:blank",
    title: async () => "",
    goto: async () => null,
    evaluate: async () => null,
    screenshot: async () => Buffer.alloc(0),
    mouse: { click: async () => {}, move: async () => {}, wheel: async () => {} },
    keyboard: { type: async () => {}, press: async () => {} },
    viewportSize: () => ({ width: 1024, height: 768 }),
    locator: () => ({
      click: async () => {},
      hover: async () => {},
      waitFor: async () => {},
      boundingBox: async () => null,
      scrollIntoViewIfNeeded: async () => {},
      evaluate: async () => null,
      first(): unknown {
        return this;
      },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await c.execute(fakePage as any, { action: "NAVIGATE" } as any);
  assert.equal(res.ok, false);
  assert.equal(res.error, "NAVIGATE requires `url`");
});


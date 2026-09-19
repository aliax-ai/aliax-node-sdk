/**
 * Integration parity test: drives a real Chromium via Playwright, runs
 * the Aliax Node SDK's parseUi() against an inline HTML fixture, and
 * asserts the produced ParseContext is structurally sound.
 *
 * Chromium discovery (in priority order):
 *   1. process.env.ALIAX_TEST_CHROMIUM_PATH — explicit override
 *   2. process.env.PLAYWRIGHT_CHROMIUM_PATH — generic Playwright override
 *   3. Falls back to Playwright's bundled browser via `chromium.launch()`
 *      with no `executablePath`. CI installs Chromium via
 *      `npx playwright install --with-deps chromium`.
 *
 * If no Chromium can be launched we SKIP rather than fail — keeps
 * `npm test` green on machines without browsers (the unit suite is the
 * required gate; integration is best-effort).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { existsSync } from "node:fs";

import { Aliax } from "../index.js";
import { imageDimensions } from "../render.js";

function resolveChromium(): string | undefined {
  const candidates = [
    process.env.ALIAX_TEST_CHROMIUM_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_PATH,
    "/chromium-1194/chrome-linux/chrome", // Lovable sandbox bundled
  ].filter((p): p is string => !!p);
  for (const p of candidates) if (existsSync(p)) return p;
  return undefined;
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Aliax Fixture</title></head>
<body style="font-family:sans-serif;margin:24px">
  <h1>Aliax integration fixture</h1>
  <button id="primary">Primary action</button>
  <button id="secondary" aria-label="Open settings">⚙</button>
  <input id="email" placeholder="email" />
  <a href="/next" id="next">Next page</a>
  <div id="card" style="padding:16px;border:1px solid #ccc;margin-top:16px">
    <label for="qty">Quantity</label>
    <input id="qty" type="number" value="1" />
    <button id="add">Add to cart</button>
  </div>
</body></html>`;

test("parseUi end-to-end against real Chromium", async (t) => {
  if (process.env.ALIAX_TEST_LIVE !== "1") {
    t.skip("Set ALIAX_TEST_LIVE=1 to run the live licensing integration test.");
    return;
  }
  const exec = resolveChromium();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(exec ? { executablePath: exec } : {}),
      args: ["--no-sandbox"],
    });
  } catch (e) {
    // No browser installed locally → skip rather than fail.
    t.skip(`Chromium unavailable for integration test: ${(e as Error).message}`);
    return;
  }
  t.after(() => browser!.close());

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.setContent(HTML, { waitUntil: "domcontentloaded" });

  const aliax = new Aliax({
    endpoint: process.env.ALIAX_TEST_ENDPOINT,
    checkForUpdates: false,
    telemetry: false,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed = await aliax.parseUi(page as any);

  assert.ok(parsed, "parseUi returned nothing");
  assert.ok(Array.isArray(parsed.elements), "elements not an array");
  assert.ok(parsed.elements.length >= 5, `expected >=5 elements, got ${parsed.elements.length}`);
  assert.ok(Buffer.isBuffer(parsed.imageBytes), "imageBytes missing/not a buffer");
  assert.ok((parsed.imageBytes as Buffer).length > 1000, "screenshot suspiciously small");

  const dims = imageDimensions(Buffer.from(parsed.imageBytes));
  assert.ok(dims, "imageBytes did not parse as JPEG/PNG");
  const [w, h] = dims!;
  assert.ok(w >= 1200 && h >= 700, `unexpected image dims ${w}x${h}`);

  for (const el of parsed.elements) {
    assert.ok(typeof el.element_id === "string" && el.element_id.length,
      `bad element id: ${JSON.stringify(el)}`);
    assert.ok(el.bounds, `missing bounds on ${el.element_id}`);
  }

  const hasPrimary = parsed.elements.some(
    (e) => typeof e.text === "string" && e.text.toLowerCase().includes("primary"),
  );
  assert.ok(hasPrimary, "primary action button not in parse map");

  await aliax.close();
});

/**
 * Decrypts the bundled `dom-mapper.dat` exactly once per asset key and
 * caches the source string in memory.
 *
 * The asset lives alongside the compiled JS (copied by the build script
 * from ../assets/). Resolving via `import.meta.url` keeps this working
 * inside zipped bundlers, monorepos and pnpm symlinked layouts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AliaxConfigError } from "./errors.js";
import { openMapper } from "./crypto.js";

let cached: string | null = null;
let cachedKey = "";

export function loadMapperSource(assetKeyHex?: string): string {
  const key = assetKeyHex ?? "plain";
  if (cached !== null && cachedKey === key) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // Try sibling (post-build dist/) then ../assets (dev/source layout).
  const candidates = assetKeyHex
    ? [join(here, "dom-mapper.dat"), join(here, "..", "assets", "dom-mapper.dat"), join(here, "..", "..", "assets", "dom-mapper.dat")]
    : [join(here, "dom-mapper.min.js"), join(here, "..", "assets", "dom-mapper.min.js"), join(here, "..", "..", "assets", "dom-mapper.min.js")];
  let lastErr: unknown = null;
  for (const p of candidates) {
    try {
      const bytes = readFileSync(p);
      cached = assetKeyHex ? openMapper(bytes, Buffer.from(assetKeyHex, "hex")) : bytes.toString("utf8");
      cachedKey = key;
      return cached;
    } catch (e) {
      lastErr = e;
    }
  }
  // Throw an SDK-typed error so callers catching `AliaxError` see it
  // instead of an opaque `Error`. This is the FIRST thing `parseUi()`
  // does — a misinstall must surface as a typed SDK failure.
  throw new AliaxConfigError(
    `Aliax: could not locate bundled mapper artifact (tried ${candidates.join(", ")}). ` +
      `Last error: ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

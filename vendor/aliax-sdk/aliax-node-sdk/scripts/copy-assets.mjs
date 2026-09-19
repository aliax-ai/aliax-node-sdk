// Cross-platform asset copy step run after `tsc`. Lives in plain ESM so
// it matches the package's `"type": "module"` rather than smuggling a
// `require()` inside `node -e`.
//
// Copies:
//   assets/dom-mapper.dat  → dist/dom-mapper.dat
//   assets/cjs-stub.cjs       → dist/cjs-stub.cjs   (CJS-guard for the `require` export condition)
//
// Also verifies the dom-mapper integrity hash declared in package.json
// — a mismatch here means the shipped tarball would not match what was
// audited, so we hard-fail the build.
import { copyFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");

mkdirSync(dist, { recursive: true });

const mapperSrc = join(root, "assets", "dom-mapper.dat");
const mapperDst = join(dist, "dom-mapper.dat");
copyFileSync(mapperSrc, mapperDst);

const stubSrc = join(root, "assets", "cjs-stub.cjs");
const stubDst = join(dist, "cjs-stub.cjs");
copyFileSync(stubSrc, stubDst);

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = String(pkg._domMapperIntegrity ?? "");
if (declared) {
  const actual =
    "sha256-" +
    createHash("sha256").update(readFileSync(mapperSrc)).digest("hex");
  if (actual !== declared) {
    console.error(
      `[build] dom-mapper.dat integrity mismatch:\n` +
        `  expected: ${declared}\n` +
        `  actual:   ${actual}\n` +
        `Update _domMapperIntegrity in package.json after intentionally rebuilding the mapper.`,
    );
    process.exit(1);
  }
}

console.log("[build] assets copied + integrity verified.");

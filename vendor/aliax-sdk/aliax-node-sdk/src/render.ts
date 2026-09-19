/**
 * Render-config normaliser + image-dimension parsers — full parity with
 * Python's `_normalize_render_config`, `_jpeg_dimensions`, `_png_dimensions`,
 * `_image_dimensions`. JPEG quality is floored at 30 because below that
 * drawn Set-of-Mark IDs become illegible to the VLM ("Blurry 88 → misclick"
 * hazard); we log a warning when a caller clamps in either direction so
 * the misconfig surfaces in production log aggregators.
 */
import type { RenderConfig } from "./types.js";

const NATIVE_FORMATS = new Set(["jpeg", "png"]);
const MIN_Q = 30;
const MAX_Q = 100;

export interface ResolvedRender {
  format: "jpeg" | "png";
  quality: number;
}

export function normaliseRenderConfig(
  rc?: RenderConfig,
  legacyFormat?: string,
  legacyQuality?: number,
): ResolvedRender {
  const rawFmt =
    (rc?.format as string | undefined) ?? legacyFormat ?? "jpeg";
  let fmt = String(rawFmt).trim().toLowerCase();
  if (fmt === "jpg") fmt = "jpeg";
  if (!NATIVE_FORMATS.has(fmt)) {
    console.warn(
      `[Aliax] render_config format="${rawFmt}" is not supported. Falling back to jpeg.`,
    );
    fmt = "jpeg";
  }

  const q = rc?.quality ?? legacyQuality;
  let qInt = typeof q === "number" && Number.isFinite(q) ? Math.trunc(q) : 80;
  if (qInt < MIN_Q) {
    console.warn(
      `[Aliax] render_config quality=${q} clamped to ${MIN_Q} ` +
        `(below that, Set-of-Mark IDs become unreadable).`,
    );
    qInt = MIN_Q;
  }
  if (qInt > MAX_Q) qInt = MAX_Q;

  return { format: fmt as "jpeg" | "png", quality: qInt };
}

/* ------------------------ image header parsers ------------------------ */

/**
 * Walk a JPEG byte stream and return [width, height] in *physical* pixels
 * (NOT CSS px — divide by dpr for CSS px). Handles fill-byte runs
 * (`FF FF ... FF Cx`), all 13 SOFn opcodes, and aborts safely on
 * truncation. Returns null when the stream is corrupt or not a JPEG.
 */
export function jpegDimensions(data: Buffer): [number, number] | null {
  if (!data || data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8)
    return null;
  const SOF = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let i = 2;
  try {
    while (i + 1 < data.length) {
      if (data[i] !== 0xff) return null;
      // Skip fill bytes: a marker is `FF Cx` but a stream may contain
      // `FF FF ... FF Cx` (Annex B padding).
      while (i < data.length && data[i] === 0xff) i++;
      if (i >= data.length) return null;
      const marker = data[i++];
      // Standalone markers (no payload): SOI, EOI, RSTn — keep walking.
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7)
      )
        continue;
      if (i + 1 >= data.length) return null;
      const segLen = (data[i] << 8) | data[i + 1];
      if (SOF.has(marker)) {
        if (i + 7 >= data.length) return null;
        const height = (data[i + 3] << 8) | data[i + 4];
        const width = (data[i + 5] << 8) | data[i + 6];
        return [width, height];
      }
      i += segLen;
    }
  } catch {
    return null;
  }
  return null;
}

/** PNG header parser — IHDR chunk lives at fixed offset 16. */
export function pngDimensions(data: Buffer): [number, number] | null {
  if (!data || data.length < 24) return null;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(sig)) return null;
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

/** Multi-format dispatcher (JPEG or PNG). Returns physical px or null. */
export function imageDimensions(data: Buffer): [number, number] | null {
  if (!data || data.length < 8) return null;
  if (data[0] === 0xff && data[1] === 0xd8) return jpegDimensions(data);
  if (data[0] === 0x89 && data[1] === 0x50) return pngDimensions(data);
  return null;
}

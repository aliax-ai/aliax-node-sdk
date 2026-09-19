/**
 * Zero-signup anonymous sandbox credentials (Node parity with the Python
 * SDK's `aliax/_anon.py` — same file, same shape, same server contract).
 *
 * `new Aliax()` with no key bootstraps a machine-scoped sandbox token
 * from the edge and caches it at `~/.aliax/credentials`, so the
 * quickstart is `npm install aliax` → run. The token is metered exactly
 * like a paid key (1 credit per `parse_ui`; `execute` and
 * `capture_failure` free) against a fixed grant that can never be topped
 * up: 500 parses from residential/corporate egress, 100 from
 * datacenter egress. Valid 30 days, then it silently re-bootstraps.
 *
 * Everything here is best-effort — a read-only filesystem or an offline
 * machine degrades gracefully and never throws into the agent loop.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, arch, platform } from "node:os";
import { join } from "node:path";

export const ANON_PREFIX = "sk_anon_";
export const SIGNUP_URL = "https://aliax.xyz/auth";
const CREDENTIALS_ENV = "ALIAX_CREDENTIALS_PATH";

export interface AnonCredential {
  api_key: string;
  endpoint: string;
  mode: "anonymous";
  tier?: string;
  granted?: number;
  remaining?: number;
  expires_at?: string;
}

export function isAnonKey(key: string): boolean {
  return key.startsWith(ANON_PREFIX);
}

export function credentialsPath(): string {
  const override = process.env.ALIAX_CREDENTIALS_PATH;
  if (override) return override;
  void CREDENTIALS_ENV;
  return join(homedir(), ".aliax", "credentials");
}

/**
 * Stable, non-identifying machine id. Hashed here before it leaves the
 * process, then hashed AGAIN server-side with a server secret — the
 * hostname itself is never transmitted.
 */
export function machineFingerprint(): string {
  const parts = [hostname() || "", platform() || "", arch() || "", homedir()];
  return createHash("sha256").update(parts.join("::")).digest("hex");
}

export function loadCached(endpointBase: string): AnonCredential | null {
  try {
    const path = credentialsPath();
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8")) as AnonCredential;
    if (!data || typeof data.api_key !== "string") return null;
    if (!isAnonKey(data.api_key)) return null;
    // Never replay a credential minted against a different backend.
    if (data.endpoint && data.endpoint !== endpointBase) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveCached(cred: AnonCredential): void {
  try {
    const path = credentialsPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(cred, null, 2), "utf8");
    try {
      chmodSync(path, 0o600);
    } catch {
      /* Windows / exotic FS */
    }
  } catch {
    /* read-only FS, sandboxed CI — caching is an optimisation only */
  }
}

export function clearCached(): void {
  try {
    rmSync(credentialsPath(), { force: true });
  } catch {
    /* ignore */
  }
}

export class AnonymousQuotaExhaustedError extends Error {}

/** `POST /v1/auth/anonymous` — mint a fresh sandbox credential. */
export async function bootstrap(
  endpointBase: string,
  sdkVersion: string,
  timeoutMs = 8000,
): Promise<AnonCredential> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpointBase}/auth/anonymous`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Aliax-SDK-Version": sdkVersion,
        "X-Request-Id": randomUUID(),
      },
      body: JSON.stringify({
        machine_id: machineFingerprint(),
        sdk_version: sdkVersion,
      }),
      signal: ac.signal,
    });
    let data: Record<string, unknown> = {};
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      data = {};
    }
    if (res.status === 429 || data["code"] === "sandbox_exhausted") {
      throw new AnonymousQuotaExhaustedError(
        (typeof data["msg"] === "string" && data["msg"]) ||
          `This network has used its free Aliax sandbox allowance. Create a free account at ${SIGNUP_URL} (1,000 credits) and set ALIAX_API_KEY.`,
      );
    }
    if (!res.ok || typeof data["api_key"] !== "string") {
      throw new Error(`Aliax anonymous bootstrap failed (HTTP ${res.status}).`);
    }
    const cred: AnonCredential = {
      api_key: data["api_key"] as string,
      endpoint: endpointBase,
      mode: "anonymous",
      tier: data["tier"] as string | undefined,
      granted: data["granted"] as number | undefined,
      remaining: data["remaining"] as number | undefined,
      expires_at: data["expires_at"] as string | undefined,
    };
    saveCached(cred);
    return cred;
  } finally {
    clearTimeout(timer);
  }
}

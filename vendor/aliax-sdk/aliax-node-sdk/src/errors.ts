/**
 * Aliax SDK errors — TypeScript port of the Python exception hierarchy.
 * Mirror class names and `.balance` / `.reason` surface so caller code
 * can be ported between the two SDKs by renaming imports only.
 */

export class AliaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AliaxError";
  }
}

/**
 * Misconfiguration error — thrown by the constructor and by the asset
 * loader when the SDK cannot start (bad API key shape, missing bundled
 * `dom-mapper.min.js`, etc.). Inherits from {@link AliaxError} so
 * callers that broadly catch `AliaxError` see it; callers that want to
 * branch on config-vs-runtime failures can target `AliaxConfigError`
 * specifically. Python parity: maps to `ValueError`.
 */
export class AliaxConfigError extends AliaxError {
  constructor(message: string) {
    super(message);
    this.name = "AliaxConfigError";
  }
}

export class AliaxOutOfCreditsError extends AliaxError {
  public balance: number | null;
  constructor(balance: number | null = null) {
    const bal = balance == null ? "unknown" : String(balance);
    super(
      `Aliax account is past its overdraft floor (balance=${bal}). ` +
        `Top up at https://aliax.xyz/dashboard — the SDK will resume ` +
        `automatically on the next call once the balance clears.`,
    );
    this.name = "AliaxOutOfCreditsError";
    this.balance = balance;
  }
}

export class AliaxInvalidKeyError extends AliaxError {
  public reason: string;
  constructor(reason: string) {
    super(
      `Aliax API key was rejected by the server (${reason}). ` +
        `Mint a new one in the dashboard.`,
    );
    this.name = "AliaxInvalidKeyError";
    this.reason = reason;
  }
}

/**
 * Public types for the Aliax TS SDK. JSON keys mirror the Python
 * dataclasses 1:1 so the wire format (`/v1/telemetry`, `/v1/capture`)
 * stays interchangeable across both SDKs.
 */

export type ElementId = string; // e.g. "el_41"

export interface ElementState {
  disabled?: boolean;
  busy?: boolean;
  invalid?: boolean;
  required?: boolean;
  readonly?: boolean;
  checked?: boolean | "mixed";
  selected?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  scrollable_x?: boolean;
  scrollable_y?: boolean;
}

export interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MappedElement {
  element_id: ElementId;
  tag: string;
  role?: string;
  text?: string;
  bounds: ElementBounds;
  editable?: boolean;
  is_canvas?: boolean;
  state?: ElementState;
  attrs?: Record<string, string>;
  links_to?: string;
}

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
  scroll_x: number;
  scroll_y: number;
  page_scrollable_x?: boolean;
  page_scrollable_y?: boolean;
}

export interface RenderConfig {
  /** Screenshot encoding. Default: `"jpeg"`. PNG is lossless but ~6× bigger. */
  format?: "jpeg" | "png";
  /**
   * JPEG quality, 30–100. Default: `80`. Values below 30 are clamped
   * to 30 (with a one-shot console warning) — below that threshold,
   * Set-of-Mark element IDs become unreadable to the VLM and cause
   * misclicks. Ignored when `format: "png"`.
   */
  quality?: number;
}

export interface ParseUiOptions {
  renderConfig?: RenderConfig;
  drawOverlay?: boolean;
  minSize?: number;
  maxElements?: number;
  /** @deprecated v0.x compat — use `renderConfig.format`. Folded into renderConfig if present. */
  imageFormat?: string;
  /** @deprecated v0.x compat — use `renderConfig.quality`. Folded into renderConfig if present. */
  imageQuality?: number;
  /** @deprecated since v1.0 — no-op. Use `renderConfig.quality` for size control. */
  maxImageDim?: number;
}

/**
 * Structural shape of a "last attempted action" payload, accepted by
 * {@link CaptureFailureOptions.lastAttemptedAction} and
 * {@link ReportIssueOptions.lastAttemptedAction}. Plain object literals
 * are supported; for type-safe construction use {@link AttemptedActionClass}
 * (re-exported from the package entry as `AttemptedAction`).
 */
export interface AttemptedActionInit {
  action: string;
  target_x?: number;
  target_y?: number;
  value?: string;
  selector?: string;
  element_id?: ElementId;
}

/** @deprecated Renamed for clarity — use {@link AttemptedActionInit}. */
export type AttemptedAction = AttemptedActionInit;

/**
 * Concrete instantiable counterpart to {@link AttemptedActionInit}. Mirrors
 * the Python `aliax.AttemptedAction` dataclass — callers can write
 * `new AttemptedActionClass({ action: "CLICK", element_id: "el_1" })` and
 * pass it directly to `captureFailure({ lastAttemptedAction })`.
 * The structural interface above is still exported for callers who prefer
 * plain object literals.
 */
export class AttemptedActionClass implements AttemptedActionInit {
  action: string;
  target_x?: number;
  target_y?: number;
  value?: string;
  selector?: string;
  element_id?: ElementId;

  constructor(init: AttemptedActionInit) {
    this.action = init.action;
    if (init.target_x != null) this.target_x = init.target_x;
    if (init.target_y != null) this.target_y = init.target_y;
    if (init.value != null) this.value = init.value;
    if (init.selector != null) this.selector = init.selector;
    if (init.element_id != null) this.element_id = init.element_id;
  }

  /** Parity with Python `AttemptedAction.to_dict()`. */
  toDict(): Record<string, unknown> {
    const out: Record<string, unknown> = { action: this.action };
    for (const k of ["target_x", "target_y", "value", "selector", "element_id"] as const) {
      const v = (this as Record<string, unknown>)[k];
      if (v != null) out[k] = v;
    }
    return out;
  }
}

export interface CaptureFailureOptions {
  goal: string;
  thoughts?: string;
  lastAttemptedAction?: AttemptedActionInit | Record<string, unknown>;
  failureReason?: string;
  step?: number;
  context?: string | Record<string, unknown>;
}

export interface ReportIssueOptions {
  reason: string;
  goal?: string;
  expectedOutcome?: string;
  actualOutcome?: string;
  step?: number;
  thoughts?: string;
  lastAttemptedAction?: AttemptedActionInit | Record<string, unknown>;
  /** Bypass the Gatekeeper. Only legitimate from developer asserts. */
  force?: boolean;
}

export type DecisionAction =
  | "CLICK"
  | "HOVER"
  | "TYPE"
  | "TYPE_AND_ENTER"
  | "PRESS"
  | "SCROLL"
  | "SCROLL_UP"
  | "SCROLL_DOWN"
  | "SCROLL_LEFT"
  | "SCROLL_RIGHT"
  | "NAVIGATE"
  | "WAIT"
  | "DONE"
  | "FINISH"
  | "NOOP"
  | "COMBO"
  | "BATCH_TYPE"
  | "REPORT_ISSUE";

/**
 * VLM decision payload. The `action` is strongly typed against the
 * known verb set (so `decision.action === "CLICK"` narrows correctly
 * and IDE completions list all verbs). LLM responses commonly carry
 * extra fields (`thoughts`, custom telemetry, etc.); the trailing
 * index signature accepts those without losing the named-field types.
 *
 * @example
 *   const d: Decision = JSON.parse(llmJson);
 *   if (d.action === "CLICK") { ... }   // narrows
 */
export interface Decision {
  action: DecisionAction;
  element_id?: ElementId;
  id?: ElementId;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  delta_x?: number;
  delta_y?: number;
  value?: string;
  text?: string;
  input?: string;
  text_input?: string;
  url?: string;
  key?: string;
  ms?: number;
  inputs?: Array<{ element_id?: ElementId; id?: ElementId; value?: string } & Record<string, unknown>>;
  actions?: Decision[];
  reason?: string;
  context?: Record<string, unknown>;
  goal?: string;
  thoughts?: string;
  /** Escape hatch — LLMs may emit arbitrary extra keys. */
  [k: string]: unknown;
}

/**
 * Result of {@link Aliax.execute} (and {@link Aliax.reportIssue}). All
 * fields the SDK ever sets are declared by name so bracket access
 * (`result["element_id"]`) and destructuring (`const { ok, ...rest }`)
 * preserve their narrow types. No index signature — the SDK owns this
 * shape and never emits keys outside the declared set.
 */
export interface ExecuteResult {
  ok: boolean;
  /** Optional — `execute()` always sets it, but `reportIssue()` returns
   *  match Python's shape (no `action` key) so callers must not branch on it. */
  action?: string;
  element_id?: ElementId;
  coords?: [number, number];
  url?: string;
  execution_tier?: string;
  status?: string;
  error?: string;
  blocked?: string;
  filled?: Array<Record<string, unknown>>;
  completed_steps?: Array<Record<string, unknown>>;
  failed_at_step?: number;
  scroll?: [number, number];
  target?: ElementId;
  value?: string;
  key?: string;
  capture_id?: string | null;
  msg?: string;
  message?: string;
  gatekeeper?: string;
  evidence?: Record<string, number>;
  screenshot_url?: string;
  debug_payload_path?: string;
  idempotent_replay?: boolean;
}

export interface BillingStatus {
  /** True iff the API key was rejected — terminal, cannot self-heal. */
  locked: boolean;
  reason: string | null;
  /** Latest server-known balance, may be negative under overdraft. */
  balance: number | null;
  /** True iff last billable ping was 402; cleared automatically by any 200. */
  credits_exhausted: boolean;
}

/**
 * Return shape of {@link Aliax.captureFailure}. Surfaced as a named type
 * so callers can annotate variables and write helper functions without
 * resorting to `Awaited<ReturnType<...>>`.
 */
export interface CaptureFailureResult {
  status: "success" | "error";
  /** Server-assigned ID for the queued capture; `null` on error or in debug mode (where it's a local stub). */
  capture_id: string | null;
  /** Public URL of the uploaded screenshot. Absent on error. */
  screenshot_url?: string;
  /** Only set in debug mode — local on-disk path of the JSON payload dump. */
  debug_payload_path?: string;
  /** True iff the server recognised the idempotency key and returned a prior result instead of re-queueing. */
  idempotent_replay?: boolean;
  msg: string;
}

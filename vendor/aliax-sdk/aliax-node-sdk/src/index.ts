/**
 * Aliax SDK — public entry point.
 *
 *     import { Aliax } from "aliax";
 *
 *     const aliax = new Aliax({ apiKey: process.env.ALIAX_API_KEY });
 *     const ctx = await aliax.parseUi(page);
 *     const decision = await askLLM(ctx.imageBytes, ctx.elements);
 *     await aliax.execute(page, decision);
 *
 * Surface is a 1:1 mirror of the Python SDK so callers can hop between
 * runtimes with zero learning curve — both `ALIAX_SYSTEM_INSTRUCTIONS`
 * and its short alias `SYSTEM_INSTRUCTIONS` are re-exported because the
 * Python `__init__` exposes both names.
 *
 * This package is ESM-only (`"type": "module"`). On Node ≥18 use:
 *     import { Aliax } from "aliax";
 * From CommonJS use a dynamic import:
 *     const { Aliax } = await import("aliax");
 */
export { Aliax, ParseContext, SDK_VERSION } from "./client.js";
export type {
  AliaxLocator,
  AliaxOptions,
  AliaxPage,
  ParseContextInit,
} from "./client.js";
export {
  AliaxConfigError,
  AliaxError,
  AliaxInvalidKeyError,
  AliaxOutOfCreditsError,
} from "./errors.js";
export {
  ALIAX_SYSTEM_INSTRUCTIONS,
  SYSTEM_INSTRUCTIONS,
} from "./prompts.js";
export type { ResolvedRender } from "./render.js";
// Concrete `AttemptedAction` class — re-exported as `AttemptedAction`
// (value) so `new AttemptedAction({...})` works just like the Python
// dataclass. Callers preferring a structural type can use the
// `AttemptedActionInit` interface re-exported below.
export { AttemptedActionClass as AttemptedAction } from "./types.js";
export type {
  AttemptedActionInit,
  BillingStatus,
  CaptureFailureOptions,
  CaptureFailureResult,
  Decision,
  DecisionAction,
  ElementBounds,
  ElementId,
  ElementState,
  ExecuteResult,
  MappedElement,
  ParseUiOptions,
  RenderConfig,
  ReportIssueOptions,
  Viewport,
} from "./types.js";

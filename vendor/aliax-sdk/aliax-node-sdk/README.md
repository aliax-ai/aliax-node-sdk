### ⚡ See it work before you install — [run the live browser benchmark →](https://aliax.xyz/benchmark)

> Paste any URL. Watch Aliax shrink the page into a tiny, numbered map your model can actually read — side-by-side with the raw HTML, in seconds. No signup, no install.

---

# Aliax — TypeScript / Node SDK

[![npm](https://img.shields.io/npm/v/aliax.svg)](https://www.npmjs.com/package/aliax)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node ≥18](https://img.shields.io/node/v/aliax.svg)](https://nodejs.org)

> 🚀 **No API Key Required to Start:** `new Aliax()` works out of the box with zero signup. It automatically provisions a free machine-scoped anonymous sandbox credential (**500 free parses** on home/office networks, **100 free parses** in cloud environments) cached locally in `~/.aliax/credentials`. You can install and run immediately.
>
> 🧠 **Stop Writing Custom Prompts:** Do NOT write or manually craft VLM system prompts from scratch. Aliax already exports `SYSTEM_INSTRUCTIONS` (or `ALIAX_SYSTEM_INSTRUCTIONS`) — a battle-tested instruction prompt tuned precisely for Set-of-Mark visual navigation, deterministic action output, and the exact `execute()` schema (`CLICK`, `TYPE`, `HOVER`, `SCROLL`, `DONE`). Import it directly: `import { SYSTEM_INSTRUCTIONS } from "aliax";`.

**The production-grade reliability layer for VLM web agents.**

Stop your AI agents from guessing browser coordinates and failing on
responsive layouts. Aliax sits between your VLM and the live page,
translates the DOM into a numbered Set-of-Mark image, executes the
action the model picks deterministically, and ships every real-world
failure into a labelled dataset you can fine-tune on.

It is the layer that turns *"works in my notebook"* into *"holds up
at 3am for paying corporate clients."*

1:1 behavioural parity with the Python [`aliax`](https://pypi.org/project/aliax/)
SDK — same constructor, same method names (snake_case → camelCase),
same VLM-facing JSON keys, same wire format, same Gatekeeper. Hop
between runtimes with zero learning curve.

## Install

```bash
npm i aliax playwright
```

`playwright` is a peer dependency. The package is ESM-only
(`"type": "module"`); from CommonJS use a dynamic import.

## Zero-Config Quickstart (No Key Needed)

You do **not** need an API key, account, or credit card to run your first agent loop:

```ts
import { Aliax, SYSTEM_INSTRUCTIONS } from "aliax";
import { chromium } from "playwright";

// Zero setup: bootstraps free anonymous sandbox automatically
const aliax = new Aliax();
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
await page.goto("https://shop.example.com/cart");

// 1. Translate the live page into a Set-of-Mark image + node map.
const ctx = await aliax.parseUi(page);

// 2. Hand both to your VLM. Drop SYSTEM_INSTRUCTIONS into the system prompt.
const decision = await askLLM({
  system: SYSTEM_INSTRUCTIONS,
  image: ctx.imageBytes,
  map: ctx.llmTextBlock(),
});

// 3. Aliax executes it natively — locator → jsclick → SPA rebind → coord fallback.
await aliax.execute(page, decision);
```

## 🧠 Pre-Packaged System Instructions (Stop Writing Prompts Manually)

The single hardest part of an AI web agent is prompt engineering: get one word wrong and your VLM will hallucinate element IDs, output invalid schemas, click disabled buttons, or get stuck in repetitive loops.

**Aliax ships a battle-tested instruction string directly in the SDK — you do not need to invent your own:**

```ts
import { SYSTEM_INSTRUCTIONS } from "aliax"; // or ALIAX_SYSTEM_INSTRUCTIONS, or Aliax.SYSTEM_INSTRUCTIONS
```

### Why you should import `SYSTEM_INSTRUCTIONS`:
1. **100% Schema Alignment:** Teaches the model the exact JSON action catalog supported by `aliax.execute()` (`CLICK`, `TYPE`, `TYPE_AND_ENTER`, `HOVER`, `SCROLL_DOWN/UP/LEFT/RIGHT`, `REPORT_ISSUE`, `DONE`).
2. **Zero-Hallucination Set-of-Mark Protocol:** Instructs Claude, GPT-4o, and Gemini on how to read numbered bounding boxes (`el_41`), inspect state flags (`DISABLED`, `REQUIRED`, `INVALID`, `BUSY`, `READONLY`), and calculate navigation paths using `linksTo`.
3. **Built-in Gatekeeper Protocol:** Details the structured Expectation-vs-Reality JSON format required by `reportIssue` and `captureFailure` when an agent is genuinely stuck.
4. **Invisible Version Upgrades:** When Aliax adds new actions or capabilities, simply updating the SDK package updates the prompt automatically — zero prompt-engineering churn on your end.

### Drop into your VLM call:

```ts
// OpenAI Node SDK (GPT-4o)
import OpenAI from "openai";
const openai = new OpenAI();

const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [
    { role: "system", content: SYSTEM_INSTRUCTIONS },
    {
      role: "user",
      content: [
        { type: "text", text: `Goal: ${userGoal}\n\nDOM Map:\n${ctx.llmTextBlock()}` },
        { type: "image_url", image_url: { url: `data:${ctx.imageMime};base64,${ctx.imageBase64}` } },
      ],
    },
  ],
  response_format: { type: "json_object" },
});
const decision = JSON.parse(response.choices[0].message.content!);
await aliax.execute(page, decision);
```

## Authentication Modes

Aliax supports three clear ways to authenticate, from instant zero-signup experimentation to locked-down enterprise deployments:

| Mode | Configuration | Allowance & Capabilities | Best For |
| :--- | :--- | :--- | :--- |
| **1. Free Anonymous Sandbox** *(Default)* | `new Aliax()` (no key passed, no env var) | **500 parses** (home/office) or **100 parses** (cloud egress). 30-day life, cached in `~/.aliax/credentials`. Full `parseUi` and `execute`. | Quickstarts, local development, evaluation without signup. |
| **2. Personal API Key** | `ALIAX_API_KEY="sk_live_..."` or `new Aliax({ apiKey: "sk_live_..." })` | **1,000 free starter credits** + pay-as-you-go top-ups. Unlocks the [web dashboard](https://aliax.xyz/dashboard) and visual crash-capture uploads ([Flight Recorder](https://aliax.xyz/captures)). | Production agents, team collaboration, crash debugging. |
| **3. Strict Enterprise Opt-Out** | `new Aliax({ allowAnonymous: false })` or `ALIAX_DISABLE_ANONYMOUS=1` | **Fail-closed.** Throws immediately if no valid API key is supplied; never contacts the edge unauthenticated. | SOC2 environments, strict CI/CD runners, air-gapped systems. |

### Upgrading from Anonymous to a Personal API Key
When you're ready for the web dashboard, visual crash captures (`captureFailure`), or more credits:
1. Create a free account at [aliax.xyz/auth](https://aliax.xyz/auth) (includes 1,000 free credits).
2. Grab your key from [API Keys](https://aliax.xyz/api-keys).
3. Set `export ALIAX_API_KEY="sk_live_..."` in your environment or secret manager. Your code doesn't need to change.

That's the entire happy path. No XPath wrangling, no Playwright
locator boilerplate, no pixel guessing.

---

## Pillar 1 — The Steady Hand

Deterministic VLM-to-DOM translation. Your model never sees raw
coordinates; it sees `el_41` and Aliax handles the browser physics.

`parseUi(page, opts?)` returns a `ParseContext`:

| Field            | Type           | Description |
|------------------|----------------|-------------|
| `imageBytes`     | `Buffer`       | Native Chromium screenshot with numbered Set-of-Mark boxes painted by the bundled JS overlay. |
| `imageMime`      | `string`       | `"image/jpeg"` (default) or `"image/png"`. |
| `imageSize`      | `[number, number]` | `[width, height]` tuple in physical pixels, returned by the mapper natively (no header parsing). |
| `elements`       | `MappedElement[]` | Each: `element_id`, `tag`, `role`, `text`, `bounds`, `editable`, `is_canvas`, `state`, `attrs`, `links_to`. Only interactable nodes ≥12 CSS px. `state` carries the full ARIA/DOM bag (`disabled`, `checked`, `expanded`, `busy`, …); `links_to` is the resolved navigation target for anchors. |
| `viewport`       | `Viewport`     | `{ width, height, dpr, scroll_x, scroll_y, page_scrollable_x, page_scrollable_y }` in CSS px. The `page_scrollable_*` booleans tell the VLM whether a scroll verb is even meaningful. |
| `url`            | `string`       | Full page URL at capture time. |
| `path`           | `string`       | URL pathname only (no host, no query). |
| `title`          | `string`       | Trimmed `document.title` (≤200 chars). |
| `truncated`      | `boolean`      | `true` iff the element list was capped at `maxElements`; `llmTextBlock()` flags this so the VLM knows the map is partial. |

Helpers: `ctx.llmTextBlock()` (drop into your prompt) and
`ctx.routeContextBlock()` (URL + title summary).

### Execute — the full verb catalog

Every `DecisionAction` your VLM can emit:

```ts
await aliax.execute(page, { action: "CLICK",          element_id: "el_41" });
await aliax.execute(page, { action: "HOVER",          element_id: "el_14" });
await aliax.execute(page, { action: "TYPE",           element_id: "el_7", value: "Nike Shoes" });
await aliax.execute(page, { action: "TYPE_AND_ENTER", element_id: "el_7", value: "Nike Shoes" });
await aliax.execute(page, { action: "PRESS",          element_id: "el_7", key: "Enter" });
await aliax.execute(page, { action: "SCROLL",         dy: 600 });           // generic
await aliax.execute(page, { action: "SCROLL_DOWN",    dy: 600 });
await aliax.execute(page, { action: "SCROLL_UP",      dy: 600 });
await aliax.execute(page, { action: "SCROLL_LEFT",    dx: 400 });
await aliax.execute(page, { action: "SCROLL_RIGHT",   dx: 400 });
await aliax.execute(page, { action: "NAVIGATE",       url: "https://..." });
await aliax.execute(page, { action: "WAIT",           ms: 1500 });
await aliax.execute(page, { action: "COMBO",          /* compound action */ });
await aliax.execute(page, { action: "BATCH_TYPE",     /* multi-field fill */ });
await aliax.execute(page, { action: "REPORT_ISSUE",   reason: "stuck" });   // routes through reportIssue()
await aliax.execute(page, { action: "NOOP" });
await aliax.execute(page, { action: "DONE" });   // `FINISH` is accepted as an alias
```

Raw coordinates are accepted as an escape hatch:

```ts
await aliax.execute(page, { action: "CLICK", x: 905, y: 150 });
```

Execution uses a three-tier locator path (locator → JS click bypass
→ SPA-wipe rebind) before falling through to coordinate clicks.
Disabled controls are refused. `execute()` **never throws** — your
agent loop stays alive.

### Token-aware rendering

VLM providers bill on file weight + dimensions. Drop quality for
~10× cheaper calls; Set-of-Mark IDs stay legible because they're
crisp DOM text rendered *before* the JPEG encoder runs.

```ts
const ctx = await aliax.parseUi(page, {
  renderConfig: { format: "jpeg", quality: 40 },
});
```

Quality is clamped to `[30, 100]` so a typo can't turn the boxes
into mush.

---

## Pillar 2 — The Flight Recorder

Every agent eventually loops on a popup or hallucinates past
recovery. Aliax ships two escalation entry points that double as
your agentic telemetry stream:

### `reportIssue()` — the gated escalation

```ts
await aliax.reportIssue(page, {
  reason: "submit_button_dead_zone",
  expectedOutcome: "navigate to /dashboard",
  actualOutcome: "still on /login after 3 tries",
});
```

A strict Gatekeeper rejects the call unless the SDK's per-page
failure history *proves* the agent is stuck:

- **3 identical SHA-256 hashes** of `(url, spatial_map)` → frozen DOM, and
- **period-2 / 3 / 4 action cycle detection** with distinct members
  per period → radio-group / checkbox loops the state hash is blind
  to (legitimate "Load More" repeats are NOT flagged).

Rejected calls never hit the API, never debit credits, and never
flood the annotation queue. Pass `force: true` only from developer
asserts.

### `captureFailure()` — the airbag

```ts
await aliax.captureFailure(page, {
  goal: "Close newsletter popup",
  thoughts: agent.currentReasoning,
  lastAttemptedAction: { action: "CLICK", element_id: "el_41" },
  failureReason: "modal_blocked",
  step: agent.loopStep,
});
```

Multipart `POST /v1/capture` with idempotency UUID, 3 attempts and
exponential backoff on 429/502/503/504, automatic fallback swap on
transport errors. The full state — screenshot, DOM map, viewport,
the agent's reasoning trail — lands in the **Aliax Inbox**.

---

## Pillar 3 — The Closed Loop

Every captured failure becomes a `(negative, positive)` DPO pair:
the agent's wrong move plus the annotator's corrected tap. Export
the dataset and fine-tune; your next deployment fails less often
on the exact failure modes that bit you in production.

```
parseUi → VLM → execute → (95% happy path)
                           ↓ stuck
                      reportIssue → Inbox → DPO dataset → fine-tune
```

---

## Public surface

```ts
import {
  Aliax,
  ParseContext,
  AttemptedAction,                 // class — `new AttemptedAction({...})`
  AliaxError,
  AliaxConfigError,
  AliaxOutOfCreditsError,
  AliaxInvalidKeyError,
  ALIAX_SYSTEM_INSTRUCTIONS,       // primary — drop into your VLM system prompt
  SYSTEM_INSTRUCTIONS,             // short alias for the same string
  SDK_VERSION,
} from "aliax";
```

| Method | Notes |
| --- | --- |
| `new Aliax({ apiKey?, endpoint?, fallbackEndpoint?, debugMode?, redactSelectors?, checkForUpdates?, telemetry?, allowAnonymous? })` | Falls back to `process.env.ALIAX_API_KEY`, then to a free anonymous sandbox credential cached in `~/.aliax/credentials` (500 parses on a home/office network, 100 from cloud egress, 30-day life, no crash captures) — opt out with `allowAnonymous: false` or `ALIAX_DISABLE_ANONYMOUS=1`. Workers.dev fallback wired automatically on the public endpoint. `telemetry: false` disables the non-blocking usage ping (airgapped / self-hosted billing). |
| `parseUi(page, { renderConfig?, drawOverlay?, minSize?, maxElements? })` | Inject mapper, blur PII, walk DOM, paint Set-of-Mark, native screenshot. Detects mid-call SPA navigation and retries once. Per-Page lock so concurrent parses can't strip each other's overlay. |
| `execute(page, decision, { typeDelayMs? })` | Full verb catalog above. Three-tier locator path before coord fallback. Never throws. |
| `reportIssue(page, { reason, expectedOutcome?, actualOutcome?, force?, ... })` | Unified escalation entrypoint with strict Gatekeeper. |
| `captureFailure(page, { goal, thoughts?, lastAttemptedAction?, failureReason?, step?, context? })` | Direct multipart upload with retry + fallback. |
| `capture(page, goal, opts?)` | **Deprecated v0.x alias** for `captureFailure()`. Kept so existing integrations keep importing without churn — prefer `captureFailure` in new code. |
| `getElementCoords(page, elementId)` | Re-resolve `{ x, y, width, height }` through the bundled mapper. |
| `billingStatus()` | In-memory snapshot: `{ locked, reason, balance, credits_exhausted }`. |
| `refreshBillingStatus()` | Force a network round-trip to refresh balance. |
| `close()` | Idempotent no-op (fetch has no pool to tear down). |

---

## Architecture

- The encrypted DOM mapper (`assets/dom-mapper.dat`) ships inside the
  package and is opened in memory only after the authenticated session
  handshake — never fetched at runtime.
- Injected exactly once per Page via `page.evaluate`, re-injected
  automatically after SPA hard navigations destroy the execution
  context.
- Set-of-Mark boxes are painted by Chromium (zero-reflow,
  `position: fixed`, `pointer-events: none`); Playwright takes a
  native screenshot; the overlay is torn down in a `try / finally`.
- A per-Page `WeakMap<Page, Promise<void>>` serialises concurrent
  `parseUi` calls so they can't strip each other's overlay
  mid-shot.
- **DNA stamps** (`data-aliax-id`) survive React re-renders,
  re-injections, and overlay redraws, so `element_id` is stable
  across the entire agent turn.
- **SSRF guard**: `NAVIGATE` rejects anything that isn't `http://`
  or `https://`.

## Build

```bash
npm install
npm run build
```

Outputs to `dist/` plus a copy of `dom-mapper.dat` next to the
compiled JS so the runtime loader finds it in published packages.

---

[Start Keyless (Free Sandbox)](https://aliax.xyz) · [Get a Personal API Key](https://aliax.xyz/auth) · [Documentation](https://aliax.xyz/docs) · [Capture Inbox](https://aliax.xyz/captures)

# DNey Inline Guardrails for Claude Web — Build Specification

**Deliverable:** A Chrome Manifest V3 extension ("DNey Guard for Claude") that enforces DNey guardrail policies inline on claude.ai — checking every user prompt before it is sent and every model response before it is shown, with block / redact / allow outcomes driven by the DNey API.

**Audience:** Claude Code. This spec is self-contained; implement it top to bottom. Where a decision is marked *(decide at build time)*, probe the live claude.ai DOM/network first and pick the most robust option.

---

## 1. Goals and non-goals

### Goals
- G1: Intercept 100% of user-composed prompts on claude.ai before they reach Anthropic, run them through DNey input rails, and block or substitute modified text per the verdict.
- G2: Intercept streamed assistant responses and enforce output rails before the user can read the content (buffer-and-release; see §5.3).
- G3: Fail-safe configurable: `fail_open` (allow on DNey timeout/error) vs `fail_closed` (block on error). Default `fail_open` with a visible warning badge.
- G4: Zero per-conversation user action. Once installed (manually or force-installed via managed browser policy), enforcement is always on for claude.ai.
- G5: Clear, non-scary UX: inline banners explaining why content was blocked/redacted, with the triggered rail names.
- G6: Local audit log (ring buffer, exportable JSON) of every check: timestamp, direction, action, rails_triggered, latency.

### Non-goals
- Claude Desktop (Electron) — out of scope; covered by the proxy architecture, not this extension.
- ChatGPT support — design the interception core as a site-adapter pattern so a chatgpt.com adapter can be added later, but do not build it now.
- Server-side anything — the extension talks only to the existing DNey API.
- Stealth/covert deployment. This is a consented, org-managed DLP control. The extension must be visibly present (toolbar icon, badge state) and its privacy behavior documented in §9. Do not implement any mode that hides its operation from the end user.

---

## 2. DNey API contract

Base URL and API key come from extension options (managed storage first, then user options; see §7).

The extension calls one endpoint (matching the existing MCP tool `check_input_output` / `check_content` semantics):

```
POST {DNEY_BASE_URL}/v1/check
Authorization: Bearer {API_KEY}
Content-Type: application/json

{
  "text": "<content to check>",
  "direction": "input" | "output",
  "metadata": {
    "surface": "claude-web",
    "conversation_id": "<uuid if derivable from URL /chat/{uuid}>",
    "user_agent_hash": "<sha256 of UA, not raw UA>"
  }
}
```

Expected response (align with current DNey response shape):

```json
{
  "action": "allowed" | "blocked" | "modified",
  "text": "<final text — modified version when action=modified, block message when blocked>",
  "original_text": "...",
  "rails_triggered": ["pii_protection", "..."],
  "latency_ms": 123.4
}
```

Implementation notes:
- Timeout: 8 s for input checks (observed p50 ≈ 3–5 s today), 4 s per output chunk-batch check. On timeout apply the fail-safe policy (G3).
- If the exact endpoint path differs, put it in config; do not hardcode. *(decide at build time: confirm against the DNey OpenAPI/openapi.json if the server exposes one.)*
- Retries: one retry on network error for input checks only. Never retry output checks (adds visible latency).

---

## 3. Extension architecture

```
manifest.json (MV3)
src/
  background.js          # service worker: DNey API client, policy cache, audit log, badge state
  content/
    main.js              # content script (ISOLATED world): UI, banners, messaging glue
    page-hook.js         # MAIN-world script: fetch/XHR interception (registered via
                         # chrome.scripting.registerContentScripts world:"MAIN" or manifest "world")
    adapter-claude.js    # site adapter: endpoint patterns + DOM selectors for claude.ai
  ui/
    banners.css
    options.html/js      # settings page
    popup.html/js        # toolbar popup: status, last 20 events, fail-safe mode indicator
```

### Why both a MAIN-world hook and a content script
Network interception must happen in the page's JS context (patching `window.fetch`) because claude.ai sends messages via `fetch` with streamed SSE responses; MV3's `declarativeNetRequest` can block URLs but cannot read or rewrite bodies. The MAIN-world script owns interception; the ISOLATED-world content script owns UI and relays check requests to the service worker (which makes the actual DNey calls, keeping the API key out of the page context). Communication: `window.postMessage` with a nonce established at injection time between MAIN and ISOLATED worlds; `chrome.runtime.sendMessage` between content script and service worker.

**The API key must never be readable by page JavaScript.** All DNey calls originate from the service worker.

### manifest.json essentials

```json
{
  "manifest_version": 3,
  "name": "DNey Guard for Claude",
  "permissions": ["storage", "scripting", "alarms"],
  "host_permissions": ["https://claude.ai/*", "https://*.dney.example/*"],
  "background": { "service_worker": "src/background.js" },
  "content_scripts": [
    { "matches": ["https://claude.ai/*"], "js": ["src/content/main.js"], "run_at": "document_start" },
    { "matches": ["https://claude.ai/*"], "js": ["src/content/page-hook.js"], "run_at": "document_start", "world": "MAIN" }
  ],
  "storage": { "managed_schema": "managed_schema.json" }
}
```

`run_at: document_start` is mandatory — the fetch patch must be installed before the app's bundle loads.

---

## 4. Input enforcement (prompt path)

### 4.1 Interception point
Patch `window.fetch` in `page-hook.js`. Match request URLs against the adapter's patterns for message-send endpoints. As of now claude.ai sends new messages via POSTs to paths matching (verify live, treat as config):

```
/api/organizations/{org}/chat_conversations/{conv}/completion
/api/organizations/{org}/chat_conversations   (conversation creation w/ first message)
```

*(decide at build time: open claude.ai DevTools, send a message, record the exact request shapes. Store patterns in `adapter-claude.js` as regexes with a JSON field-path map for where prompt text lives in the body, e.g. `body.prompt` or `body.messages[-1].content`. Expect this to change; see §8 resilience.)*

### 4.2 Flow
1. Hooked fetch sees a matching POST. Parse body JSON; extract prompt text via adapter field map.
2. Hold the request. Send `{type:"dney-check", direction:"input", text}` to the content script → service worker → DNey API.
3. On verdict:
   - `allowed` → release the original request unchanged.
   - `modified` → rewrite the body's prompt field with `text`, then release. Show an inline banner: "DNey modified your message (rails: …)" with a *view diff* expander.
   - `blocked` → **do not send.** Reject the fetch with a synthetic `Response` the app treats as a handled error *(decide at build time: test whether claude.ai UI handles a 4xx JSON error gracefully; if it retries or breaks, instead intercept at the DOM layer — see 4.3 — so the request is never constructed)*. Show a blocking banner with the DNey block message and rails.
   - timeout/error → apply fail-safe mode; log; badge turns amber.
4. Log the event to the audit ring buffer regardless of outcome.

### 4.3 Belt-and-suspenders DOM layer (required)
Independently of the fetch hook, the content script also intercepts the composer as a first line of defense and UX anchor:
- Locate the prompt editor (ProseMirror contenteditable; selector in adapter, currently `div[contenteditable="true"].ProseMirror` — verify live).
- Capture `Enter` keydown (without Shift) and clicks on the send button in the **capture phase**, prevent default, run the check, then programmatically re-dispatch the send if allowed / write back modified text if modified.
- If both layers are active, the fetch hook recognizes an already-checked message via a short-lived token (checked text hash, 10 s TTL) and passes it through without a second DNey call.

The DOM layer gives good UX (spinner on the send button: "Checking…"); the fetch layer guarantees coverage for paths the DOM layer misses (retry button, edit-and-resend, keyboard shortcuts, future UI changes). **The fetch layer is the enforcement guarantee; the DOM layer is UX.**

### 4.4 Attachments
File uploads are out of scope for v1 (they flow through separate upload endpoints). Log a `coverage_gap` audit event when a message with attachments passes so the org can see unscanned volume. v2 hook: intercept the upload POST and send extracted text to DNey.

---

## 5. Output enforcement (response path)

### 5.1 The problem
Responses stream as SSE over the completion fetch. True inline enforcement means the user must not see unchecked tokens, which conflicts with streaming UX. Checking per-token is absurd (cost, latency); letting the full message render and retro-hiding it is a leak.

### 5.2 Strategy: buffer-and-release with progressive chunk checks
Wrap the SSE `ReadableStream` in the fetch hook with a `TransformStream`:

1. Hold back the stream from the app. Show a lightweight skeleton state in the UI (content script overlays "Response being checked by DNey…" on the pending message bubble).
2. Accumulate decoded text. Every `CHUNK_SIZE` chars (default 800) **or** every `CHUNK_INTERVAL` ms (default 2500), send the accumulated-so-far text to DNey (`direction:"output"`).
   - `allowed` → release all buffered SSE events downstream to the app; continue buffering new ones. The user experiences slightly chunky streaming, ~2.5 s behind live.
   - `modified` → stop the passthrough: cancel the upstream stream, synthesize SSE events carrying the modified text so the app renders DNey's version, close the stream cleanly. Banner: "Response modified by guardrail (rails: …)".
   - `blocked` → cancel upstream, synthesize a final SSE event with the DNey block message styled as the assistant's reply, close. Banner with rails.
3. On stream end, run one final check on the complete text (cheap incremental: only if the tail since the last check is non-empty). This is the authoritative output verdict for the audit log.

*(decide at build time: claude.ai's SSE event grammar — event names, JSON payload shape, and completion sentinel — must be captured from a live session and encoded in the adapter. Synthesized events must match it exactly or the UI will hang; include an integration test that replays a recorded SSE transcript through the transform.)*

### 5.3 Modes (org-configurable)
- `enforce_hard`: as above — nothing unchecked ever renders. Default for enforce-mode orgs.
- `enforce_soft`: stream live; on a `blocked`/`modified` verdict, immediately overlay/replace the rendered message. Small exposure window (≤ one check interval), much better UX. Good default during rollout.
- `monitor`: stream untouched; checks run async; only log + badge. Maps to DNey monitor-mode rails.

### 5.4 Incremental-check semantics
DNey currently re-checks full text each call. Send `metadata.incremental: {check_seq, prior_verdict}` so the backend can optimize later; the extension must remain correct with a stateless backend (always send full accumulated text).

---

## 6. UX specification

- **Toolbar badge:** green dot = active & healthy; amber = DNey unreachable, fail-open active; red = fail-closed blocking; gray = disabled for this site.
- **Popup:** enforcement mode, last 20 audit events (direction, action, rails, latency), "export audit log" button, link to options.
- **Inline block banner (input):** replaces send: red-bordered card above the composer — "Message blocked by {org} policy · Rails: {list} · {DNey message}" with "Edit message" (restores composer text) . Never silently drop user text: the composer content must survive a block.
- **Inline modified banner:** amber card, collapsed diff view (original vs modified), "Send original anyway" only if org config `allow_override: true`.
- **Output block:** assistant bubble shows the DNey block message plus a shield glyph; tooltip lists rails.
- **Latency affordance:** send button shows spinner + "Checking…" during input checks. If p95 input check > 6 s over the last 20 checks, popup shows a persistent latency warning.

All UI text comes from a strings module for future i18n. No emojis in enforcement banners.

---

## 7. Configuration & deployment

Config precedence: **managed storage** (`chrome.storage.managed`, set via Chrome Enterprise policy for force-installed deployments) → sync storage (user options) → defaults.

```json
{
  "dney_base_url": "https://api.dney.example",
  "api_key": "",                    // managed deployments inject per-org key; never sync a managed key to user storage
  "input_mode": "enforce",          // enforce | monitor | off
  "output_mode": "enforce_soft",    // enforce_hard | enforce_soft | monitor | off
  "fail_policy": "open",            // open | closed
  "allow_override": false,
  "chunk_size": 800,
  "chunk_interval_ms": 2500,
  "input_timeout_ms": 8000,
  "output_timeout_ms": 4000,
  "audit_buffer_size": 500
}
```

Managed schema (`managed_schema.json`) mirrors these fields. When managed storage supplies a value, the options UI shows it locked with "Set by your organization".

Deployment paths, in order of seamlessness:
1. **Chrome Enterprise force-install** (`ExtensionInstallForcelist` + `ExtensionSettings` policy with `installation_mode: force_installed` and managed config) — true zero-touch for org fleets.
2. Chrome Web Store unlisted listing for self-serve customer installs.
3. Developer-mode load for the pilot (what you'll test with this week).

---

## 8. Resilience to claude.ai changes

The claude.ai frontend is unversioned and will change. Requirements:
- All endpoint regexes, body field paths, DOM selectors, and SSE grammar live in `adapter-claude.js` as one exported object — nothing site-specific outside it.
- **Self-test on startup:** on first page load per session, the adapter validates its selectors (composer found? send button found?) and, passively, its endpoint patterns (first observed completion request matches?). On failure: badge amber, one-time banner "DNey Guard may be out of date," audit event `adapter_degraded`, and — critically — the DOM layer falls back to *composer-level* enforcement only (which degrades gracefully) while the fetch layer logs unmatched candidate endpoints (paths only, no bodies) to help you ship an adapter update.
- Ship adapter as remotely-updatable config *(decide at build time: fetch signed adapter JSON from DNey CDN with 24 h cache; fall back to bundled copy — keeps you off the 3-day Web Store review path for selector fixes)*.

## 9. Privacy & security requirements

- Prompt/response text goes **only** to the configured DNey endpoint over TLS. No third-party calls, no analytics SDKs.
- API key: service-worker memory + `storage.managed`/`storage.local` only; never in page world, never logged.
- Audit log stores rails + verdicts + text *hashes* by default; full-text capture is an explicit org opt-in (`audit_capture_text: true`).
- The extension must not read any site other than the adapters' match list. Host permissions minimal.
- CSP-safe: no remote code, no `eval` — remotely-fetched adapter files are **data (JSON config), never executable code**, validated against a strict schema and a signature before use (MV3 requirement and Web Store policy).
- Document all of the above in the listing privacy disclosure; this is a monitoring tool and must say so plainly.

## 10. Testing & acceptance

Automated (Playwright, headless Chrome with the extension loaded; Chromium is preinstalled in the Claude Code cloud env):
1. Mock DNey server (local express) with scripted verdicts.
2. Recorded claude.ai SSE transcript replayed through the TransformStream → assert release/modify/block behavior and that synthesized events parse.
3. DOM harness: static claude.ai-like page exercising composer intercept (Enter, Shift+Enter, send click, blocked → composer text preserved).
4. Fail-safe matrix: DNey down × {open, closed} × {input, output}.
5. Double-check suppression: DOM-layer-checked message must not trigger a second API call at the fetch layer.

Manual acceptance on live claude.ai:
- A message containing a fake SSN is modified (PII rail) and the modified text is what appears in the conversation history.
- A blocked input never appears in the conversation and never hits the network (verify in DevTools).
- Output enforce_hard: no unchecked token ever visible (screen-record and scrub).
- Latency: p50 added send latency ≤ DNey check latency + 150 ms overhead.
- Kill DNey mid-conversation → amber badge, fail-open works, audit shows errors.

**Definition of done:** all automated tests green; manual acceptance checklist passes on live claude.ai; README with policy-deployment instructions (Chrome Enterprise JSON examples) included.

---

## 11. Build order (suggested for Claude Code)

1. Scaffold MV3 extension + adapter module + mock DNey server; wire service-worker API client with fail-safe logic. Unit tests.
2. DOM-layer input enforcement + banners on a static harness page.
3. MAIN-world fetch hook + body rewrite + synthetic block responses; integrate with live claude.ai behind `monitor` mode to capture real endpoint shapes and SSE grammar into the adapter.
4. Output TransformStream with buffer-and-release; SSE replay tests.
5. Options/popup/managed storage; audit log + export.
6. Hardening: self-test, adapter degradation path, latency telemetry. Full acceptance run.

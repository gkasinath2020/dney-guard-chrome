# chatgpt.com adapter — live probe findings (2026-08-01)

Captured live via a fetch hook on chatgpt.com (signed-in session). Basis for a
future `adapter-chatgpt.ts`. Verdict: **INPUT rail is buildable** with the same
DOM-intercept + fetch-hook approach; **OUTPUT rail is a much bigger lift** than
claude.ai (compressed delta-encoding SSE).

## Send endpoint
```
POST https://chatgpt.com/backend-api/f/conversation
```
- Regex: `/\/backend-api\/(f\/)?conversation\b/` (POST).
- Also loads OpenAI telemetry; matcher must be specific to this path.

## Request body — where the prompt lives (DIFFERENT from claude.ai)
Top-level keys: `action, messages, parent_message_id, model, client_prepare_state,
timezone_offset_min, timezone, conversation_mode, enable_message_followups,
system_hints, supports_buffering, supported_encodings, client_contextual_info, …`

- The prompt is **NOT** a top-level `prompt` string. It's the **last element of
  `messages[]`**, at `content.parts[0]`:
  - `messages[last] = { id, author, create_time, content, metadata }`
  - `content = { content_type: "text", parts: ["<the user text>"] }`
- Adapter getPrompt → `body.messages.at(-1).content.parts[0]` (only when content_type=="text").
- Adapter setPrompt → replace that same `parts[0]`, re-stringify. Guard for
  non-text content_type (images/tools) — pass through unchecked (log a coverage gap).

## Response SSE — compressed delta-encoding (HARD for output synthesis)
Event names: `delta_encoding`, `delta`, `[DONE]`.
Data uses a JSON-patch-like op stream:
- keys seen: `type, kind, token, conversation_id, p, o, v, c, input_message, message_id, marker, event, title`
- ops (`o`): `add`, `append`, `patch`; paths (`p`): e.g. `/message/content/parts/0`; value in `v`.
- The assistant text arrives as `append` ops to `/message/content/parts/0`.

Implication: output-rail buffer-and-release + **synthesizing** a block/modify
response here means emitting valid delta-encoding patch frames — significantly more
complex than claude.ai's plain Anthropic SSE. Recommend: ship ChatGPT **input-only**
first; treat output rail as a later, ChatGPT-specific effort.

## DOM (composer / send)
- Composer: `#prompt-textarea` — a `div[contenteditable="true"].ProseMirror`
  (same ProseMirror family as claude.ai, so the capture-phase Enter/click intercept
  transfers).
- Send button: not present when the composer is empty; appears on input. Use
  `button[data-testid="send-button"]` (historical) with an aria fallback
  (`button[aria-label*="Send"]`); confirm the exact selector at build time by
  probing with text in the composer.

## Adapter-selection
Select the adapter by `location.hostname` (claude.ai → claudeAdapter,
chatgpt.com → chatgptAdapter). Add `https://chatgpt.com/*` to host_permissions +
content-script matches. The SiteAdapter interface already fits; getPrompt/setPrompt
become messages[].content.parts[0]-aware for ChatGPT.

## Effort estimate
- Input enforcement (block/modify prompt): SMALL–MEDIUM (endpoint + parts[0] get/set
  + hostname routing + host perms). Reuses the existing DOM/fetch machinery.
- Output enforcement: LARGE (delta-encoding). Defer.

## STATUS: gated OFF (2026-08-02)

ChatGPT is removed from the manifest matches + host_permissions — the extension
ships **Claude-only** for now. The adapter code (`adapter-chatgpt.ts`,
`adapters.ts` hostname routing) stays in the tree, dormant.

**Why:** live debugging showed the DOM-layer send-prevention SWALLOWS sends on
ChatGPT — messages not sent, composer text LOST, no banner, and `guardSend` never
even reaches its check (the banner host is never created). ChatGPT's ProseMirror
clears the composer text before `guardSend` reads it, so it hits the empty-text
path. The `checkInput` timeout fix (MR fix/chatgpt-guardsend-timeout) did NOT
resolve it — the problem is upstream of the check. Claude is unaffected.

**Path forward (separate effort):** make the FETCH layer the PRIMARY enforcement
for ChatGPT (the completion POST body carries the real prompt at
`messages[last].content.parts[0]` — reliable, unlike the cleared DOM). Block =
reject/synthesize there; skip the DOM-intercept for ChatGPT. Then re-enable the
manifest matches.

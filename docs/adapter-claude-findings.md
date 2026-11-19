# claude.ai adapter — live probe findings (2026-07-31)

Captured live via a `window.fetch` hook injected into claude.ai (signed-in session).
These resolve the spec's "*(decide at build time)*" unknowns for `adapter-claude.ts`.
**Everything site-specific must live in that one module** — the frontend is
unversioned and will change (spec §8), so treat all of this as config + self-test.

## Interception validated
A MAIN-world `fetch` patch successfully (a) read the completion **request body**
and (b) `tee()`'d the SSE **response stream** while the app rendered normally — i.e.
the spec's core buffer-and-release mechanism works on the live page. This is the
enforcement layer.

## Completion endpoint (message send)
```
POST https://claude.ai/api/organizations/{orgUuid}/chat_conversations/{convUuid}/completion
```
- New-chat flow first creates the conversation, then POSTs the completion (spec §4.1 confirmed).
- Endpoint regex (adapter): `/\/api\/organizations\/[0-9a-f-]+\/chat_conversations\/[0-9a-f-]+\/completion$/`

## Request body (JSON) — where the prompt lives
Top-level keys observed:
`prompt`, `parent_message_uuid`, `timezone`, `locale`, `model`, `effort`,
`thinking_mode`, `tools`, `turn_message_uuids`, `attachments`, `files`,
`sync_sources`, `rendering_mode`.

- **Prompt text lives in `body.prompt`** (a top-level string). ← the adapter's input field-path.
- Rewrite path for `modified`: replace `body.prompt`, re-`JSON.stringify`, release.
- `attachments` / `files` present → the §4.4 attachment coverage-gap hook keys off these.

## Response SSE grammar (output rail)
Standard Anthropic Messages-API SSE. Event names (and matching `data.type`):
```
message_start
content_block_start
content_block_delta   ← carries the streamed text tokens (buffer these)
content_block_stop
message_delta
message_limit
message_stop          ← completion sentinel (final authoritative check here)
```
- Buffer `content_block_delta` text; run output checks per §5.2; synthesize
  `content_block_delta` + `message_stop` events for modify/block, matching this grammar exactly.

## DOM (composer / UX layer — §4.3)
- Composer: `textbox` with accessible name **"Write your prompt to Claude"** — a
  ProseMirror `contenteditable`. Selector to verify live:
  `div[contenteditable="true"].ProseMirror` (fall back to `[aria-label="Write your prompt to Claude"]`).
- Send: Enter (no Shift) submits; a send button also appears bottom-right of the composer.

## Notes / gotchas
- claude.ai loads Datadog RUM (`browser-intake-*.datadoghq.com`) and posts to
  `/api/event_logging/v2/batch` — the adapter's endpoint matcher must be specific
  to `…/completion` so it never touches telemetry/other API calls.
- The org UUID here is the **claude.ai** org, unrelated to a DNey org.
- Self-test (§8): on load, assert composer selector resolves AND the first observed
  `…/completion` POST matches the regex; degrade to composer-only + log unmatched
  candidate paths (paths only, never bodies) on mismatch.

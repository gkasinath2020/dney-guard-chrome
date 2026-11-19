# DNey Guard

A Chrome (Manifest V3) extension that checks what you type into ChatGPT
(chatgpt.com) and Claude (claude.ai) against your Dney guardrail policies when you
send it, and blocks or changes the message before it leaves the page if a
guardrail says so. It needs a free Dney account. It shows that it is present
(toolbar badge) and stores no message text.

[Add DNey Guard to Chrome](https://chromewebstore.google.com/detail/dney-guard-ai-guardrails/pelcglbblplfjhadghbclobecnljjebl)

## What it checks, and what it does not

Checked: the text you send in a ChatGPT or Claude conversation.

Not checked:

- **The AI's replies.** The popup says so ("AI replies: not checked yet").
- **Attachments and file uploads.** They go through separate upload endpoints.
- **Non-text content** (images, tool content) passes through unchecked.
- **Other sites.** Only chatgpt.com and claude.ai.

If Dney cannot be reached, or cannot check a message:

- a personal install **fails open**: the message is sent unchecked and the badge
  shows it was not checked;
- a school or enterprise (managed) install **fails closed** by default: the
  message is held. An organization can choose fail-open in its policy.

No filter catches everything. If something got through, or a harmless message was
blocked, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Privacy

Message text goes only to the configured Dney endpoint (default
`https://api.dney.dev`) over TLS, to be checked. For the LLM-based part of a check,
Dney sends the text to its language-model provider (currently OpenAI). Dney doesn't store the text of your messages:
it is held in memory while it is checked. See the
[privacy policy](https://dney.dev/privacy). The API key lives in the service
worker and extension storage, never in the page. The local audit log keeps the
guardrail names, verdicts and timing, never message text. No third-party calls, no
analytics, no remote code.

## Configure

The popup and options page cover sign-in and settings. An organization can also
set them through Chrome Enterprise managed policy, which takes precedence and
locks the field: `dney_base_url`, `api_key`, `enrolment_token`, `input_mode`,
`output_mode`, `fail_policy`, `allow_override` and the timeouts (see
`managed_schema.json` for the full list). Defaults live in
`src/lib/config.ts`.

### Enterprise force-install

Use `ExtensionInstallForcelist` + `ExtensionSettings` with
`installation_mode: force_installed` and a managed config matching
`managed_schema.json`.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build       # -> dist/  (load unpacked in Chrome)
npm run mock        # scripted Dney mock on http://localhost:8790
```

Load unpacked: `chrome://extensions` → Developer mode → **Load unpacked** → select
`dist/`. Design notes: [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md) and the
site-adapter findings in `docs/`.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as
described in [SECURITY.md](SECURITY.md), never in a public issue.

## License

Apache License 2.0. See [LICENSE](LICENSE).

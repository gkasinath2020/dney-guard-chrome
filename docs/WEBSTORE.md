# Chrome Web Store Publishing Checklist

An ordered checklist for publishing **DNey Guard** to friendly testers. Verified
against the current Chrome for Developers docs (Aug 2026). The single upload
artifact is one `.zip` of the `dist/` folder.

**Which visibility?** For handing it to a known set of friendlies, two options —
pick one in the Distribution tab (step 6):

- **Private (trusted testers)** — *recommended for testing.* Only the Google
  accounts you list as trusted testers can see/install it. Tightest control.
- **Unlisted** — anyone with the Web Store link can install; not in search or
  category browsing. Simpler to share, but the link is effectively open.

## 0. Prerequisite: a hosted privacy policy (REQUIRED)

The Web Store **requires a privacy-policy URL** for any item that handles
personal/sensitive user data — and DNey Guard sends the user's **prompt text**
to the DNey endpoint for checking, so this applies to us. You cannot publish or
update the item without it.

- [ ] Host a privacy policy at a stable URL (e.g. `https://dney.dev/privacy`).
- [ ] It must state, at minimum: what's collected (the prompt text you send on
      claude.ai), where it goes (the configured DNey endpoint, default
      `https://api.dney.dev`), why (real-time policy evaluation only), that it's
      **not sold** and **not used for ads**, and that model responses are **not**
      read or sent (the output rail isn't built). The data categories it names
      MUST match what you select on the Privacy tab in step 5.

## 1. One-time account setup

- [ ] Create a **Chrome Web Store developer account** at
      <https://chrome.google.com/webstore/devconsole>. **One-time $5 registration
      fee** (covers up to 20 published extensions). Note: the account email
      **cannot be changed later**.
- [ ] **Verify your contact email** (Account tab) — required; shown under the
      extension's contact info and used for review notifications.
- [ ] Set a **Publisher display name** (Account tab) — required; appears under
      the extension title.
- [ ] *(Only if going Private in step 6)* add **Trusted tester** emails in the
      account settings — a comma-separated list of testers' **Google-account**
      email addresses (or a Google Group you own/manage). Plain alias/forum group
      emails are not supported; each must be a real Google account that can
      install from the store.

## 2. Build and package

- [ ] Bump `version` in `manifest.json` (currently `0.1.0`). **Every re-upload
      needs a higher version** than the last uploaded one.
- [ ] Build so `dist/` is fresh:
      ```bash
      npm ci && npm run build
      ```
- [ ] Create the upload zip from inside `dist/`:
      ```bash
      cd dist && zip -r ../dney-guard-chrome-v0.1.0.zip . && cd ..
      ```
      This is the file you upload (git-ignored — an artifact, not source). Max
      package size is 2 GB (we're far under).

## 3. Create the item

- [ ] In the Developer Dashboard, click **Add new item** and upload
      `dney-guard-chrome-v0.1.0.zip`.

## 4. Store listing tab

- [ ] **Name:** `DNey Guard for Claude`
- [ ] **Description** (prompts-only — do NOT claim it reads responses):
      > DNey Guard adds inline guardrail enforcement to claude.ai. As you chat,
      > it checks your prompts against your organization's DNey policies before
      > they're sent, blocking or modifying messages that break the rules.
      > Configure it once with your API key and it works quietly in the
      > background.
- [ ] **Store icon** (128×128) — already bundled at `icons/icon128.png`.
- [ ] **At least one screenshot** (1280×800 or 640×400) is required — a shot of
      the settings page or a banner firing on claude.ai works.
- [ ] Pick a **category** (e.g. Productivity) and the listing **language**.

## 5. Privacy tab (all required to publish/update)

- [ ] **Single purpose:** Guardrail policy enforcement on claude.ai — checking
      the user's prompts against their organization's DNey policies before
      sending.
- [ ] **Permission justifications** (one per manifest permission). The manifest
      declares only `storage` plus host permissions — `scripting`/`alarms` were
      removed as unused (declaring an unused permission is a rejection cause):
  - `storage` — save the user's API key and endpoint, and a small local activity
    log (rule names + timestamps only). No prompt/response content is stored.
  - Host permission — `https://claude.ai/*` (the content script reads the prompt
    being sent so it can be checked) and `https://api.dney.dev/*` (send the
    prompt to the DNey service for evaluation).
- [ ] **Remote code:** declare **No** — this is Manifest V3; all code is bundled
      in the package, nothing is remotely hosted or `eval`'d.
- [ ] **Data collection disclosures:** select the categories matching what's
      collected — the prompt text the user sends (maps to *website content* /
      *personal communications*). These MUST match the privacy policy from
      step 0.
- [ ] **Limited-use certification:** tick the compliance checkboxes certifying
      the data is used only for the single purpose above (not sold, not for ads,
      no unrelated use).
- [ ] **Privacy policy URL:** paste the URL from step 0.

## 6. Distribution tab

- [ ] **Visibility:** choose **Private** (installs limited to your trusted
      testers from step 1) or **Unlisted** (anyone with the link).
- [ ] **Pricing:** Free.
- [ ] **Regions:** all regions (or restrict as you like).

## 7. Submit

- [ ] Click **Submit for review** and confirm. (Leave "publish automatically
      after review" checked, or uncheck to hold it as a draft you publish
      manually — you then have up to **30 days** to publish before it reverts to
      draft.)
- [ ] Review time **varies by item** (often a few days for a small extension —
      there's no fixed SLA). You'll get an email at your verified account address.

## 8. Share with testers

- [x] Put the store link into `docs/INSTALL.md`. Live listing:
      https://chromewebstore.google.com/detail/dney-guard-for-claude/pelcglbblplfjhadghbclobecnljjebl
- [ ] Send friendlies the link + `docs/INSTALL.md` (the non-technical setup
      guide). For **Private**, each tester must be on the trusted-tester list AND
      signed into that Google account in Chrome.
- [ ] **Mint a per-tester DNey API key** for each friendly (they paste it into
      the extension's Settings; Base URL stays `https://api.dney.dev`). Per-tester
      keys keep usage attributable (audit `source` = `browser_extension`).

## Reminder

The only file you upload is the single `.zip`. Any code change means: bump
`version` in `manifest.json`, rebuild, re-zip, and upload the new zip.

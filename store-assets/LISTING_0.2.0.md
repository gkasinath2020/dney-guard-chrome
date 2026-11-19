# Chrome Web Store listing for 0.2.0 (paste-ready)

Upload `dney-guard-chrome-v0.2.0.zip` (Package tab) and
`store-assets/dney-listing-1280x800.png` (Store listing → Screenshots).
The NAME and the summary line come from `manifest.json` and are not pasted:

> Name: DNey Guard: AI prompt guardrails for Claude & ChatGPT


> Checks your prompts on Claude or ChatGPT against your DNey guardrails before they're sent. Blocks or redacts what breaks the rules.

ChatGPT carries "(beta)" everywhere until Assay's live check on the store
build passes; then it comes off everywhere at once (description, image).

---

## Store listing → Description

What's new in 0.2.0
• ChatGPT support (beta). DNey Guard now checks your prompts on chatgpt.com as well as claude.ai. Chrome will ask you to approve access to chatgpt.com, and the extension stays paused until you do.
• Safer on managed devices. When your organisation installs DNey Guard through its device policy, it now blocks a message it can't check instead of letting it through.
• Clearer status. The popup shows when a message went out unchecked, and says plainly that AI replies are not checked yet. The unused "Output mode" setting is gone.
Your existing settings and API key carry over.

DNey Guard adds guardrails to claude.ai and chatgpt.com (beta). When you send a prompt, it checks the text you typed or pasted against your DNey guardrails before it reaches the AI, and blocks the message or redacts the matching part (for example a Social Security number) when a rule fires.

New DNey accounts start with three guardrails switched on: prompt injection (attempts to override the AI's instructions, including ones hidden in text you paste in), personal data (masks Social Security numbers, email addresses and phone numbers; blocks card numbers), and data exfiltration (links or images that would send your conversation elsewhere, and API keys in common formats like OpenAI, AWS and GitHub).

To check a prompt, DNey Guard sends its text to the DNey service; DNey uses OpenAI for some of its checks. DNey never stores your prompt text. It keeps only metadata such as which rule fired and when. See the privacy policy at https://dney.dev/privacy.

What it does not do: it does not check the AI's replies, attachments or files, and if the DNey service can't be reached in time, a personal install sends the message unchecked and shows a warning. A device-policy install blocks it instead.

Set up takes about five minutes: sign up free at dney.dev (no card), create an API key, and paste it into the extension's options.

---

## Privacy tab

**Single purpose:** Guardrail policy enforcement on claude.ai and chatgpt.com: checking the user's prompts against their DNey guardrails before sending.

**Permission justifications:**
- `storage`: saves the user's API key and settings. A short activity list (action, rule names, timestamps; no prompt text) is kept in memory only.
- Host permissions: `https://claude.ai/*` and `https://chatgpt.com/*`, where the content script reads the prompt being sent so it can be checked; `https://api.dney.dev/*`, which sends the prompt to the DNey service for evaluation.

**Remote code:** No.

**Data usage (what the extension collects):** tick exactly these:
- Personal communications: yes (the prompts are the user's chat messages, sent to the DNey service).
- Website content: yes (the text typed or pasted into claude.ai / chatgpt.com is read and sent).
- Authentication information: yes (the DNey API key is stored locally and sent as a request header).
- Everything else: no (personally identifiable information, health, financial and payment, location, web history, user activity).

**Limited Use certifications:** tick all three:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://dney.dev/privacy

`identity` is intentionally NOT declared in 0.2.0 (no Google client ID is built in, so student sign-in can't run). It returns in the school release.

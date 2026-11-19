// Where Settings are saved (SCRUM-395, Assay: publish-blocking). The API key goes
// to chrome.storage.LOCAL only; every other (non-secret) setting stays in
// chrome.storage.sync. This is the ONLY place in the extension that writes sync
// (test/key-storage.test.ts pins that), and it never writes api_key there.
import type { Config } from "./types";

export function withoutKey(values: Partial<Config>): Partial<Config> {
  const { api_key: _key, ...rest } = values;
  void _key;
  return rest;
}

/**
 * Save the options page. A non-empty key is written to local; an EMPTY key field
 * clears the key from local AND from sync (a 0.2.0 leftover, if any). Changing or
 * clearing the key also forgets the popup's key id (SCRUM-437).
 */
export async function saveSettings(values: Partial<Config>): Promise<void> {
  if ("api_key" in values) {
    const key = typeof values.api_key === "string" ? values.api_key.trim() : "";
    const { api_key: current } = (await chrome.storage.local.get("api_key")) as { api_key?: unknown };
    if (key) {
      await chrome.storage.local.set({ api_key: key });
    } else {
      await chrome.storage.local.remove("api_key");
    }
    // SCRUM-437: the stored key id names the key the popup minted. A different (or
    // no) key from Settings makes it stale, and a later sign-in must never revoke
    // a key this browser is not using.
    if (key !== current) await chrome.storage.local.remove("api_key_id");
    await chrome.storage.sync.remove("api_key");
  }
  await chrome.storage.sync.set(withoutKey(values));
}

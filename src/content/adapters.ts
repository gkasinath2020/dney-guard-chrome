// Adapter registry: pick the site adapter by hostname. Content scripts only run
// on the configured sites, but callers should still null-check.
import type { SiteAdapter } from "./adapter-types";
import { claudeAdapter } from "./adapter-claude";
import { chatgptAdapter } from "./adapter-chatgpt";

const ADAPTERS: SiteAdapter[] = [claudeAdapter, chatgptAdapter];

const HOST_MATCH: Array<[RegExp, SiteAdapter]> = [
  [/(^|\.)claude\.ai$/i, claudeAdapter],
  [/(^|\.)chatgpt\.com$/i, chatgptAdapter],
];

export function getAdapter(host: string = location.hostname): SiteAdapter | null {
  for (const [re, adapter] of HOST_MATCH) if (re.test(host)) return adapter;
  return null;
}

export { claudeAdapter, chatgptAdapter, ADAPTERS };
export type { SiteAdapter };

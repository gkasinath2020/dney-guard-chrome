// Shared fakes for the SCRUM-392 onboarding tests: an in-memory chrome.storage
// (managed / sync / local / session), and a fetch that replays REAL responses
// captured from a local asgard-services at origin/main 5925bbb
// (test/fixtures/scrum392/captured, secrets replaced with placeholders).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

export const ACCESS_TOKEN = "eyJ.test-access-token.SIGNATURE-7f3a";
export const RAW_KEY = "asg_test_raw_key_9c1e";
export const PASSWORD = "correct-horse-battery";

export function captured(name: string): { status: number; headers: Record<string, string>; body: unknown } {
  const raw = readFileSync(join(__dirname, "..", "fixtures", "scrum392", "captured", `${name}.json`), "utf8")
    .replaceAll("<ACCESS_TOKEN>", ACCESS_TOKEN)
    .replaceAll("<RAW_KEY>", RAW_KEY);
  return JSON.parse(raw);
}

export function responseOf(c: { status: number; headers?: Record<string, string>; body: unknown }): Response {
  return new Response(JSON.stringify(c.body), { status: c.status, headers: c.headers ?? {} });
}

/** A fetch that answers by path from a queue of captured responses (or errors). */
export function routedFetch(routes: Record<string, (Response | Error)[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init: init ?? {} });
    const path = new URL(u).pathname;
    const q = routes[path];
    const next = q?.shift();
    if (!next) throw new Error(`unexpected fetch ${path}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

export interface FakeChrome {
  areas: Record<"managed" | "sync" | "local" | "session", Record<string, unknown>>;
  tabsCreated: { url: string; active: boolean }[];
  chrome: unknown;
}

function area(store: Record<string, unknown>) {
  return {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return { ...store };
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, store[k]]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(store, items);
    }),
    remove: vi.fn(async (k: string | string[]) => {
      for (const key of Array.isArray(k) ? k : [k]) delete store[key];
    }),
  };
}

export function installFakeChrome(init: { managed?: Record<string, unknown>; sync?: Record<string, unknown>; local?: Record<string, unknown> } = {}): FakeChrome {
  const areas = { managed: { ...(init.managed ?? {}) }, sync: { ...(init.sync ?? {}) }, local: { ...(init.local ?? {}) }, session: {} };
  const tabsCreated: { url: string; active: boolean }[] = [];
  const listeners: Record<string, ((...a: unknown[]) => unknown)[]> = {};
  const ev = (name: string) => ({ addListener: (fn: (...a: unknown[]) => unknown) => (listeners[name] ??= []).push(fn) });
  const chrome = {
    storage: { managed: area(areas.managed), sync: area(areas.sync), local: area(areas.local), session: area(areas.session) },
    tabs: {
      create: vi.fn(async (p: { url: string; active: boolean }) => {
        tabsCreated.push({ url: p.url, active: p.active });
        return { id: 100 + tabsCreated.length };
      }),
      update: vi.fn(async () => ({})),
    },
    runtime: {
      id: "ext-id",
      getURL: (p: string) => `chrome-extension://ext-id/${p}`,
      onMessage: ev("onMessage"),
      onInstalled: ev("onInstalled"),
      onStartup: ev("onStartup"),
      openOptionsPage: vi.fn(),
    },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    _listeners: listeners,
  };
  (globalThis as { chrome?: unknown }).chrome = chrome;
  return { areas, tabsCreated, chrome };
}

export function removeFakeChrome(): void {
  delete (globalThis as { chrome?: unknown }).chrome;
}

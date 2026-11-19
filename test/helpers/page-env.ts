// A claude.ai page with the real content scripts in it (the esbuild bundles
// Chrome loads, built from src on the fly), one fresh jsdom page per test. Each
// page gets its own fake `chrome`, which a test can kill the way an extension
// update kills the context of a tab that was already open.
import { join } from "node:path";
import { build } from "esbuild";
// @ts-expect-error -- jsdom ships no types and @types/jsdom is not a dependency
import { JSDOM } from "jsdom";
import { DEFAULT_CONFIG } from "../../src/lib/config";
import type { Config, Verdict } from "../../src/lib/types";

const ROOT = join(__dirname, "..", "..");

export async function buildContentScripts(): Promise<{ main: string; hook: string }> {
  const out = await build({
    entryPoints: { main: join(ROOT, "src/content/main.ts"), hook: join(ROOT, "src/content/page-hook.ts") },
    bundle: true,
    format: "iife",
    target: "chrome120",
    write: false,
    outdir: "/out",
    logLevel: "silent",
  });
  const get = (n: string) => out.outputFiles.find((f) => f.path.endsWith(`/${n}.js`))!.text;
  return { main: get("main"), hook: get("hook") };
}

export const COMPLETION_URL =
  "https://claude.ai/api/organizations/0f0f0f0f-0000-4000-8000-000000000001/chat_conversations/0f0f0f0f-0000-4000-8000-000000000002/completion";

export interface FakeRuntime {
  chrome: unknown;
  checks: string[];
  /** The extension updated under this tab: its context is gone. */
  kill(how: "no-id" | "throws"): void;
}

export function fakeRuntime(opts: { failPolicy?: Config["fail_policy"]; noConfig?: boolean } = {}): FakeRuntime {
  const checks: string[] = [];
  const config: Config = { ...DEFAULT_CONFIG, api_key: "k", fail_policy: opts.failPolicy ?? "open" };
  let dead = false;
  const runtime: Record<string, unknown> = {
    id: "ext-id",
    lastError: undefined,
    sendMessage(msg: { type: string; text?: string }, cb?: (r: unknown) => void) {
      if (dead) throw new Error("Extension context invalidated.");
      let reply: unknown = true;
      if (msg.type === "dney-config") reply = opts.noConfig ? null : { config };
      if (msg.type === "dney-check") {
        checks.push(msg.text!);
        const v: Verdict = { action: "allowed", text: msg.text!, original_text: msg.text!, rails_triggered: [], latency_ms: 1, failed: false };
        reply = v;
      }
      setTimeout(() => cb?.(reply), 1);
    },
  };
  return {
    chrome: { runtime, storage: { onChanged: { addListener() {} } } },
    checks,
    kill(how) {
      dead = true;
      if (how === "no-id") delete runtime.id;
    },
  };
}

export interface Page {
  win: Window & typeof globalThis;
  run(code: string, chrome?: unknown): void;
  button: HTMLButtonElement;
  /** Requests that reached the network (below the hook). */
  network: { prompt: string }[];
  pageSends: number;
  banners(): { kind: string; text: string }[];
}

export function makePage(prompt: string): Page {
  const dom = new JSDOM(
    `<!doctype html><html><body><div contenteditable="true" class="ProseMirror">${prompt}</div>` +
      `<button aria-label="Send message">Send</button></body></html>`,
    { url: "https://claude.ai/new", runScripts: "outside-only" },
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  // jsdom leaves MessageEvent.source null; Chrome sets it to the posting window,
  // and both bridges require it. Delivered as a later task, in order, as in Chrome.
  win.postMessage = ((data: unknown) => {
    setTimeout(() => win.dispatchEvent(new win.MessageEvent("message", { data, source: win })), 0);
  }) as typeof win.postMessage;
  const network: { prompt: string }[] = [];
  win.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    network.push({ prompt: JSON.parse(String(init?.body)).prompt });
    return new Response("ok");
  }) as typeof fetch;
  (win as unknown as { console: Console }).console = { ...console, debug() {}, warn() {} } as Console;
  const composer = win.document.querySelector(".ProseMirror") as HTMLElement;
  const button = win.document.querySelector("button") as HTMLButtonElement;
  const page: Page = {
    win,
    button,
    network,
    pageSends: 0,
    run(code, chrome) {
      (win as unknown as { eval(c: string): (c: unknown) => void }).eval(`(function (chrome) {${code}\n})`)(chrome);
    },
    banners() {
      return [...win.document.querySelectorAll(".dney-banner")].map((b) => ({
        kind: [...b.classList].find((c) => c !== "dney-banner") ?? "",
        text: b.querySelector(".msg")?.textContent ?? b.textContent ?? "",
      }));
    },
  };
  // The site's own send handler: POSTs the composer text through window.fetch.
  button.addEventListener("click", () => {
    page.pageSends++;
    win.fetch(COMPLETION_URL, { method: "POST", body: JSON.stringify({ prompt: composer.textContent ?? "" }) }).catch(() => {});
  });
  return page;
}

/** Let tasks run (real timers) until `cond` holds or `ms` pass. */
export async function until(cond: () => boolean, ms = 1000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

export const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

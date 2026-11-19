// Signed-in chatgpt.com sends POST /backend-api/f/conversation/prepare WHILE the
// user types (client_prepare_source "composer_editor_state"), with partial_query =
// the draft as a message object (GK's HAR, 15 Oct). Neither layer looked at it, so
// a pasted draft (an email, a key) could reach OpenAI before DNey checked anything.
// The hook now strips the draft (partial_query: null, a value ChatGPT itself sends)
// instead of checking every keystroke.
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- jsdom ships no types and @types/jsdom is not a dependency
import { JSDOM } from "jsdom";
import { buildContentScripts, settle } from "./helpers/page-env";
import { DEFAULT_CONFIG } from "../src/lib/config";
import { chatgptAdapter } from "../src/content/adapter-chatgpt";
import type { Config, Verdict } from "../src/lib/types";

const PREPARE = "https://chatgpt.com/backend-api/f/conversation/prepare";
const SEND = "https://chatgpt.com/backend-api/f/conversation";

/** The captured prepare's fields, in captured order (dummy values). */
function prepareBody(draft: string | null): string {
  return JSON.stringify({
    action: "next",
    client_prepare_dispatch: "debounced",
    client_prepare_source: "composer_editor_state",
    client_prepare_state: "none",
    conversation_id: "68ef0000-0000-0000-0000-000000000000",
    is_do_not_remember: false,
    local_function_names: [],
    model: "auto",
    parent_message_id: "client-created-root",
    partial_query:
      draft === null
        ? null
        : { id: "11111111-2222-3333-4444-555555555555", author: { role: "user" }, content: { content_type: "text", parts: [draft] } },
    timezone: "America/New_York",
    timezone_offset_min: 240,
  });
}

describe("adapter.stripDraft (pure)", () => {
  it("nulls partial_query and leaves every other field identical and in order", () => {
    const raw = prepareBody("email me at a@b.co");
    const out = chatgptAdapter.stripDraft!(PREPARE, raw) as string;
    expect(out).toBe(prepareBody(null));
    expect(Object.keys(JSON.parse(out))).toEqual(Object.keys(JSON.parse(raw)));
  });

  it("the non-/f/ path and a query string match too", () => {
    expect(chatgptAdapter.stripDraft!("/backend-api/conversation/prepare?x=1", prepareBody("d"))).toBe(prepareBody(null));
  });

  it("partial_query already null: the body is returned as-is", () => {
    const raw = prepareBody(null);
    expect(chatgptAdapter.stripDraft!(PREPARE, raw)).toBe(raw);
  });

  it("not a prepare URL, or the SEND: undefined (untouched)", () => {
    expect(chatgptAdapter.stripDraft!(SEND, prepareBody("d"))).toBeUndefined();
    expect(chatgptAdapter.stripDraft!("https://chatgpt.com/unauth-mweb/conversation/prepare", prepareBody("d"))).toBeUndefined();
    expect(chatgptAdapter.stripDraft!("https://chatgpt.com/backend-api/f/conversation/prepared", prepareBody("d"))).toBeUndefined();
  });

  it("an unreadable body (not a string, not JSON, not an object): undefined (passed through)", () => {
    expect(chatgptAdapter.stripDraft!(PREPARE, undefined)).toBeUndefined();
    expect(chatgptAdapter.stripDraft!(PREPARE, new URLSearchParams("a=1"))).toBeUndefined();
    expect(chatgptAdapter.stripDraft!(PREPARE, "{not json")).toBeUndefined();
    expect(chatgptAdapter.stripDraft!(PREPARE, "[1,2]")).toBeUndefined();
  });
});

describe("the real hook on a signed-in page", () => {
  let scripts: { main: string; hook: string };
  beforeAll(async () => {
    scripts = await buildContentScripts();
  });

  async function page() {
    const dom = new JSDOM(`<!doctype html><body><form><div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div>
      <button data-testid="send-button" type="button">Send</button></form></body>`, {
      url: "https://chatgpt.com/",
      runScripts: "outside-only",
    });
    const win = dom.window as unknown as Window & typeof globalThis;
    win.postMessage = ((data: unknown) => {
      setTimeout(() => win.dispatchEvent(new win.MessageEvent("message", { data, source: win })), 0);
    }) as typeof win.postMessage;
    const network: { url: string; body: unknown }[] = [];
    win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      network.push({ url: String(input), body: init?.body });
      return new Response("ok");
    }) as typeof fetch;
    (win as unknown as { console: Console }).console = { ...console, debug() {}, warn() {} } as Console;
    const checks: string[] = [];
    const config: Config = { ...DEFAULT_CONFIG, api_key: "k", fail_policy: "open" };
    const chrome = {
      runtime: {
        id: "ext-id",
        lastError: undefined,
        sendMessage(msg: { type: string; text?: string }, cb?: (r: unknown) => void) {
          let reply: unknown = true;
          if (msg.type === "dney-config") reply = { config };
          if (msg.type === "dney-check") {
            checks.push(msg.text!);
            reply = { action: "allowed", text: msg.text, original_text: msg.text, rails_triggered: [], latency_ms: 1, failed: false } as Verdict;
          }
          setTimeout(() => cb?.(reply), 1);
        },
      },
      storage: { onChanged: { addListener() {} } },
    };
    const run = (code: string, c?: unknown) =>
      (win as unknown as { eval(c: string): (c: unknown) => void }).eval(`(function (chrome) {${code}\n})`)(c);
    run(scripts.main, chrome);
    run(scripts.hook);
    await settle(30);
    return { win, network, checks };
  }

  it("a pasted draft never leaves: partial_query goes out null, no check, no banner", async () => {
    const p = await page();
    await p.win.fetch(PREPARE, { method: "POST", body: prepareBody("my key is sk-live-123 and a@b.co") });
    expect(p.network).toHaveLength(1);
    expect(JSON.parse(String(p.network[0].body)).partial_query).toBeNull();
    expect(String(p.network[0].body)).not.toContain("a@b.co");
    expect(p.checks).toEqual([]);
    expect(p.win.document.querySelectorAll(".dney-banner").length).toBe(0);
  });

  it("an unreadable prepare body passes through unchanged (never blocks the page)", async () => {
    const p = await page();
    await p.win.fetch(PREPARE, { method: "POST", body: "{not json" });
    expect(p.network.map((n) => n.body)).toEqual(["{not json"]);
    expect(p.checks).toEqual([]);
  });

  it("the SEND is still checked as before", async () => {
    const p = await page();
    const body = JSON.stringify({ messages: [{ content: { content_type: "text", parts: ["hello"] } }] });
    await p.win.fetch(SEND, { method: "POST", body });
    expect(p.checks).toEqual(["hello"]);
  });
});

// @vitest-environment jsdom
// SCRUM-329: every allowed or modified send was checked TWICE. The DOM layer
// preapproved the text by postMessage (delivered in a later task), then its
// re-send click made the page fetch synchronously, so the MAIN-world hook had not
// heard of the preapproval yet and checked again. These run the REAL main.ts and
// page-hook.ts together in one jsdom page with a stub worker that counts checks.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/config";
import {
  PREAPPROVAL_TTL_MS,
  createPreapprovals,
  createRewrites,
  normalizePrompt,
  sendPreapproval,
  sendRewrite,
} from "../src/lib/preapproval";
import type { Verdict } from "../src/lib/types";

vi.mock("../src/content/adapters", async (orig) => {
  const real = await orig<typeof import("../src/content/adapters")>();
  // The site-agnostic modify mechanism, exercised on a send the hook CAN rewrite
  // (claude.ai's legacy /completion). Real claude.ai now sends through a channel
  // it cannot rewrite, so there a mask BLOCKS instead (SCRUM-452,
  // test/scrum452-claude-mask-blocks.test.ts); these keep the mechanism covered.
  return { ...real, getAdapter: () => ({ ...real.claudeAdapter, cannotRewriteSend: false }) };
});

const COMPLETION = "https://claude.ai/api/organizations/abc-123/chat_conversations/def-456/completion";

// --- stub worker: counts every input check that reaches DNey -----------------
let checks: string[] = [];
let verdictFor: (text: string) => Verdict = (text) => verdict("allowed", text);
function verdict(action: Verdict["action"], text: string): Verdict {
  return { action, text, original_text: text, rails_triggered: [], latency_ms: 1, failed: false };
}

// --- the page: a composer, a send button whose handler fetches SYNCHRONOUSLY ---
let composerValue = "";
// What the site puts in the body for the composer's text (it serialises it itself).
let bodyFor: (composer: string) => string = (t) => t;
// Whether setComposerText's edit reaches what the page sends. On real signed-in
// ChatGPT it did not (SCRUM-441): the page sent the original text.
let editSticks = true;
const origFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true }) as Response);
let composer: HTMLElement;
let btn: HTMLButtonElement;

/** The site's own send handler: it calls fetch synchronously, in the click's task. */
function pageSend(): void {
  void window
    .fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: bodyFor(composerValue) }) })
    .catch(() => undefined);
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
const sentPrompts = () => origFetch.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).prompt);
const banners = (kind: string) => document.querySelectorAll(`.dney-banner.${kind}`).length;

beforeAll(async () => {
  (globalThis as any).chrome = {
    runtime: {
      id: "ext-id", // a live context (a dead one has none: stale-tab-banner.test.ts)
      lastError: undefined,
      sendMessage(msg: any, cb?: (r: unknown) => void) {
        let resp: unknown;
        if (msg.type === "dney-check") {
          checks.push(msg.text);
          resp = verdictFor(msg.text);
        } else if (msg.type === "dney-config") {
          resp = { config: DEFAULT_CONFIG };
        }
        setTimeout(() => cb?.(resp), 0);
      },
    },
    storage: { onChanged: { addListener() {} } },
  };
  composer = document.createElement("div");
  composer.setAttribute("contenteditable", "true");
  composer.className = "ProseMirror";
  // jsdom has no layout, so no innerText: give it the browser's paragraph form.
  Object.defineProperty(composer, "innerText", { get: () => composerValue, configurable: true });
  btn = document.createElement("button");
  btn.setAttribute("aria-label", "Send message");
  btn.addEventListener("click", pageSend);
  document.body.append(composer, btn);
  // setComposerText (the modify path) edits via execCommand, which jsdom lacks.
  (document as any).execCommand = (cmd: string, _ui: boolean, value?: string) => {
    if (cmd === "insertText" && editSticks) composerValue = value ?? "";
    return true;
  };
  // jsdom's postMessage leaves ev.source null; a browser sets it to the window, and
  // both scripts require that. Keep it ASYNC, like the browser: that ordering is
  // exactly what made the old postMessage preapproval arrive too late.
  window.postMessage = ((data: unknown) => {
    setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data, source: window })), 0);
  }) as typeof window.postMessage;
  window.fetch = origFetch as unknown as typeof fetch;
  await import("../src/content/page-hook");
  await import("../src/content/main");
  await settle();
});

beforeEach(() => {
  checks = [];
  origFetch.mockClear();
  verdictFor = (text) => verdict("allowed", text);
  bodyFor = (t) => t;
  editSticks = true;
  document.getElementById("dney-guard-banners")?.replaceChildren();
});

/** The user presses send; wait until everything has settled. */
async function userSends(text: string): Promise<void> {
  composerValue = text;
  btn.click();
  await settle();
}

describe("one check per send (DOM layer + fetch hook together)", () => {
  it("one-line message: checked once, sent once", async () => {
    await userSends("hello there");
    expect(checks).toEqual(["hello there"]);
    expect(sentPrompts()).toEqual(["hello there"]);
  });

  it("two paragraphs, body == composer text: checked once", async () => {
    await userSends("para one\n\npara two");
    expect(checks).toHaveLength(1);
    expect(origFetch).toHaveBeenCalledTimes(1);
  });

  it("two paragraphs, body uses a single newline where the composer has two: checked once", async () => {
    bodyFor = (t) => t.replace(/\n\n/g, "\n");
    await userSends("alpha para\n\nbeta para");
    expect(checks).toEqual(["alpha para\n\nbeta para"]);
    expect(sentPrompts()).toEqual(["alpha para\nbeta para"]);
  });

  it("text changed beyond whitespace between check and send: checked again (exactly 2)", async () => {
    bodyFor = (t) => `${t} and then something else`;
    await userSends("edited after check");
    expect(checks).toEqual(["edited after check", "edited after check and then something else"]);
    expect(origFetch).toHaveBeenCalledTimes(1);
  });

  it("a programmatic completion fetch with no DOM send: checked exactly once", async () => {
    await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: "programmatic only" }) });
    expect(checks).toEqual(["programmatic only"]);
    expect(origFetch).toHaveBeenCalledTimes(1);
  });

  it("block: one check, nothing sent, one block banner", async () => {
    verdictFor = () => verdict("blocked", "Blocked by policy.");
    await userSends("please block me");
    expect(checks).toHaveLength(1);
    expect(origFetch).not.toHaveBeenCalled();
    expect(banners("block")).toBe(1);
  });

  it("modify: one check, the MODIFIED text is sent, exactly one modify banner", async () => {
    verdictFor = (t) => (t === "my ssn is 123" ? verdict("modified", "my ssn is [REDACTED]") : verdict("allowed", t));
    await userSends("my ssn is 123");
    expect(checks).toEqual(["my ssn is 123"]);
    expect(sentPrompts()).toEqual(["my ssn is [REDACTED]"]);
    expect(banners("modify")).toBe(1);
  });

  it("three sends = three checks (the original report was 3 sends = 6)", async () => {
    for (const t of ["first send", "second send", "third send"]) await userSends(t);
    expect(checks).toHaveLength(3);
    expect(origFetch).toHaveBeenCalledTimes(3);
  });
});

describe("SCRUM-441: modify when the composer edit does not reach the page", () => {
  const mask = (t: string) =>
    t === "email me at a@b.co" ? verdict("modified", "email me at [EMAIL]") : verdict("allowed", t);

  it("one check, the MASKED text is sent, exactly one modify banner", async () => {
    editSticks = false;
    verdictFor = mask;
    await userSends("email me at a@b.co");
    expect(checks).toEqual(["email me at a@b.co"]);
    expect(sentPrompts()).toEqual(["email me at [EMAIL]"]);
    expect(banners("modify")).toBe(1);
  });

  it("any later check FAILING cannot unmask it: the masked text is still what is sent (Assay)", async () => {
    editSticks = false;
    let n = 0;
    // The first check masks; every later one gets no verdict (timeout/5xx/throttle),
    // which a fail-open install would send as-is.
    verdictFor = (t) => (n++ === 0 ? mask(t) : (undefined as unknown as Verdict));
    await userSends("email me at a@b.co");
    expect(checks).toHaveLength(1);
    expect(sentPrompts()).toEqual(["email me at [EMAIL]"]);
    expect(banners("warn")).toBe(0);
  });

  it("the rewrite is one-shot: the same original fetched again is checked", async () => {
    editSticks = false;
    verdictFor = mask;
    await userSends("email me at a@b.co");
    await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: "email me at a@b.co" }) });
    expect(checks).toEqual(["email me at a@b.co", "email me at a@b.co"]);
    expect(sentPrompts()).toEqual(["email me at [EMAIL]", "email me at [EMAIL]"]);
  });

  it("the masked preapproval is spent by the rewritten send (a later masked fetch is checked)", async () => {
    editSticks = false;
    verdictFor = mask;
    await userSends("email me at a@b.co");
    await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: "email me at [EMAIL]" }) });
    expect(checks).toEqual(["email me at a@b.co", "email me at [EMAIL]"]);
  });

  it("edit DID stick: the masked send spends the rewrite too (the original fetched later is checked)", async () => {
    verdictFor = mask;
    await userSends("email me at a@b.co");
    expect(sentPrompts()).toEqual(["email me at [EMAIL]"]);
    await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: "email me at a@b.co" }) });
    expect(checks).toEqual(["email me at a@b.co", "email me at a@b.co"]);
  });

  it("a different text is never rewritten by a pending rewrite", async () => {
    sendRewrite("secret one", "[MASKED]");
    await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: "secret two" }) });
    expect(checks).toEqual(["secret two"]);
    expect(sentPrompts()).toEqual(["secret two"]);
  });

  it("a malformed rewrite event is ignored (checked as usual)", async () => {
    document.dispatchEvent(new CustomEvent("dney-guard-rewrite", { detail: "not json" }));
    document.dispatchEvent(new CustomEvent("dney-guard-rewrite", { detail: { from: "x", to: "y" } }));
    await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: "x" }) });
    expect(checks).toEqual(["x"]);
    expect(sentPrompts()).toEqual(["x"]);
  });
});

describe("the preapproval reaches the hook synchronously", () => {
  it("is visible to the hook BEFORE btn.click() returns (click -> fetch in the same task is skipped)", () => {
    composerValue = "sync click text";
    // What reSend does once the guard lets it through: preapprove, then the page's
    // click handler fetches in the same task. Asserted with NO await in between.
    sendPreapproval("sync click text");
    pageSend();
    expect(origFetch).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(0);
  });

  it("a postMessage 'preapprove' (the old path) is not honoured", async () => {
    window.postMessage({ channel: "dney-guard", kind: "preapprove", text: "old path text" }, "*");
    await settle();
    await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: "old path text" }) });
    expect(checks).toEqual(["old path text"]);
  });

  it("is one-shot: a second identical send without a new preapproval is checked", async () => {
    sendPreapproval("one shot text");
    const body = { method: "POST", body: JSON.stringify({ prompt: "one shot text" }) };
    await window.fetch(COMPLETION, body);
    expect(checks).toHaveLength(0);
    await window.fetch(COMPLETION, body);
    expect(checks).toEqual(["one shot text"]);
  });
});

describe("preapproval store (pure)", () => {
  afterEach(() => vi.useRealTimers());

  it("normalises every whitespace run, nbsp included", () => {
    expect(normalizePrompt("  a\n\nb\t c d\r\n ")).toBe("a b c d");
  });

  it("matches across whitespace differences, not across text differences", () => {
    const s = createPreapprovals();
    s.add("a\n\nb");
    expect(s.consume("a b and more")).toBe(false);
    expect(s.consume("a\nb")).toBe(true);
  });

  it("expires after 10 s", () => {
    vi.useFakeTimers();
    const s = createPreapprovals();
    s.add("late");
    s.add("on time");
    vi.advanceTimersByTime(PREAPPROVAL_TTL_MS - 1);
    expect(s.consume("on time")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(s.consume("late")).toBe(false);
  });

  it("never preapproves empty text", () => {
    const s = createPreapprovals();
    s.add(" \n ");
    expect(s.consume("")).toBe(false);
  });
});

describe("rewrite store (pure)", () => {
  afterEach(() => vi.useRealTimers());

  it("matches the original across whitespace, returns the masked text, once", () => {
    const s = createRewrites();
    s.add("a\n\nb", "[M]");
    expect(s.peek("a b")).toBe("[M]");
    expect(s.take("a\nb")).toBe("[M]");
    expect(s.take("a b")).toBeNull();
  });

  it("expires after 10 s", () => {
    vi.useFakeTimers();
    const s = createRewrites();
    s.add("orig", "[M]");
    vi.advanceTimersByTime(PREAPPROVAL_TTL_MS);
    expect(s.take("orig")).toBeNull();
  });

  it("never stores an empty original or an empty replacement", () => {
    const s = createRewrites();
    s.add(" ", "[M]");
    s.add("orig", "");
    expect(s.take("")).toBeNull();
    expect(s.take("orig")).toBeNull();
  });
});

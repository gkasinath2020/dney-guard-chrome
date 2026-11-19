// P0: on chatgpt.com SIGNED OUT nothing was checked. That page is a different app:
// a <textarea id="mobile-composer-prompt"> in a real <form>, and the send is
// POST /unauth-mweb/conversation/updates with a URLSearchParams OBJECT body whose
// `prompt` field is the text. Neither layer matched it. These run the REAL content
// scripts (esbuild bundles, as Chrome loads them) in a jsdom page built from the
// 2026-10-15 capture (dom_typed2.json, requests.json), one fresh page per test.
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- jsdom ships no types and @types/jsdom is not a dependency
import { JSDOM } from "jsdom";
import { buildContentScripts, settle, until } from "./helpers/page-env";
import { DEFAULT_CONFIG } from "../src/lib/config";
import { UNREADABLE_BLOCK_MESSAGE } from "../src/lib/bridge-policy";
import { chatgptAdapter } from "../src/content/adapter-chatgpt";
import { PREAPPROVE_EVENT } from "../src/lib/preapproval";
import type { Config, Verdict } from "../src/lib/types";

const UPDATES =
  "https://chatgpt.com/unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=b07ac725-835c-4f68-bcbf-8ddf97ab147d";
const PREPARE = "/unauth-mweb/conversation/prepare?lightweight_authenticated=0";

/** The captured send's fields, in captured order (dummy values; `prompt` is filled in). */
function updatesBody(prompt: string): URLSearchParams {
  return new URLSearchParams([
    ["conversationState", '{"messages":[],"parentMessageId":"client-created-root","safety":{"dismissedInterventionIds":[]},"userMessageCount":0}'],
    ["messageMetadata", "{}"],
    ["oai-session-id", "00169497-d164-43be-9e71-860010c75699"],
    ["imageAttachments", "[]"],
    ["pendingImageUploads", "[]"],
    ["prompt", prompt],
    ["clientContextualInfo", '{"app_name":"chatgpt.com","page_width":1280}'],
    ["imageSaveData", "off"],
    ["imageEffectiveType", "4g"],
    ["timezone", "America/New_York"],
    ["timezoneOffsetMinutes", "240"],
    ["conversationRetryOwner", '{"mode":"anonymous","sessionEpoch":null}'],
    ["workOrigin", ""],
    ["workModel", ""],
    ["workEffort", ""],
    ["workTier", ""],
    ["assistantMessageId", "pending-64d73f74-0f0e-4e8d-af13-cc98185a0c0b"],
    ["userMessageId", "adfb454b-72c2-41d8-8bda-2e1d0fdde74d"],
    ["chatRequirementsToken", "gAAAAABq0Mhi+O3iw/r7vN=="],
    ["proofToken", "gAAAAABWzIx ODAs+IlRo/dSBP==&x=1"],
    ["turnstileToken", "SREWABwL%BAwC+EHNL/HmEQ=="],
    ["telemetryToken", "0,1062"],
    ["timingToken", "[1,null]"],
  ]);
}
const prepareBody = () =>
  new URLSearchParams([
    ["conversationRetryOwner", '{"mode":"anonymous","sessionEpoch":null}'],
    ["conversationState", '{"messages":[],"parentMessageId":"client-created-root","userMessageCount":0}'],
    ["timezone", "America/New_York"],
    ["timezoneOffsetMinutes", "240"],
  ]);

let scripts: { main: string; hook: string };
beforeAll(async () => {
  scripts = await buildContentScripts();
});

function v(action: Verdict["action"], text: string): Verdict {
  return { action, text, original_text: text, rails_triggered: [], latency_ms: 1, failed: false };
}

interface Sent {
  url: string;
  body: unknown;
  init: RequestInit | undefined;
}

/**
 * The signed-out page from the capture. The site's own behaviour, as captured:
 * its submit handler preventDefaults and POSTs the composer through window.fetch
 * with a URLSearchParams body. Its prompt comes from its OWN state, kept in sync
 * by `input` events (as a framework would), not from reading the DOM at send.
 */
async function loggedOutPage(opts: { failPolicy?: Config["fail_policy"]; verdict?: (t: string) => Verdict } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <form action="/unauth-mweb/conversation" method="post" data-logged-out data-mobile-composer>
        <div><div><textarea id="mobile-composer-prompt" name="prompt" aria-label="Chat with ChatGPT"
          data-mobile-composer-prompt placeholder="Ask ChatGPT" required rows="1"></textarea></div></div>
        <button type="submit" aria-label="Send message" data-composer-submit data-send-label="Send message">Send</button>
      </form></body></html>`,
    { url: "https://chatgpt.com/", runScripts: "outside-only" },
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  win.postMessage = ((data: unknown) => {
    setTimeout(() => win.dispatchEvent(new win.MessageEvent("message", { data, source: win })), 0);
  }) as typeof win.postMessage;
  const network: Sent[] = [];
  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    network.push({ url: String(input), body: init?.body, init });
    return new Response("ok");
  }) as typeof fetch;
  const warnings: string[] = [];
  (win as unknown as { console: Console }).console = {
    ...console,
    debug() {},
    warn: (...a: unknown[]) => void warnings.push(a.map(String).join(" ")),
  } as Console;

  // --- stub worker -----------------------------------------------------------
  const checks: string[] = [];
  const config: Config = { ...DEFAULT_CONFIG, api_key: "k", fail_policy: opts.failPolicy ?? "open" };
  const verdictFor = opts.verdict ?? ((t: string) => v("allowed", t));
  const chrome = {
    runtime: {
      id: "ext-id",
      lastError: undefined,
      sendMessage(msg: { type: string; text?: string }, cb?: (r: unknown) => void) {
        let reply: unknown = true;
        if (msg.type === "dney-config") reply = { config };
        if (msg.type === "dney-check") {
          checks.push(msg.text!);
          reply = verdictFor(msg.text!);
        }
        setTimeout(() => cb?.(reply), 1);
      },
    },
    storage: { onChanged: { addListener() {} } },
  };

  const doc = win.document;
  const form = doc.querySelector("form") as HTMLFormElement;
  const textarea = doc.querySelector("textarea") as HTMLTextAreaElement;
  const button = doc.querySelector("button") as HTMLButtonElement;
  let state = ""; // the site's own idea of the composer text
  textarea.addEventListener("input", () => (state = textarea.value));
  const page = { submits: [] as Event[], pageSubmits: 0 };
  // Sees every submit first (window capture), to check later it was preventDefaulted.
  win.addEventListener("submit", (e) => page.submits.push(e), true);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    page.pageSubmits++;
    win.fetch(UPDATES, { method: "POST", body: updatesBody(state) }).catch(() => {});
  });

  const run = (code: string, c?: unknown) =>
    (win as unknown as { eval(c: string): (c: unknown) => void }).eval(`(function (chrome) {${code}\n})`)(c);
  run(scripts.main, chrome);
  run(scripts.hook);
  await settle(30); // the relay has told the hook the policy

  const type = (text: string) => {
    textarea.value = text;
    textarea.dispatchEvent(new win.Event("input", { bubbles: true }));
  };
  const banners = () =>
    [...doc.querySelectorAll(".dney-banner")]
      .map((b) => ({ kind: [...b.classList].find((c) => c !== "dney-banner") ?? "", text: b.textContent ?? "" }))
      .filter((b) => b.kind !== "checking");
  const sends = () => network.filter((n) => n.url.includes("/conversation/updates"));
  return { win, doc, form, textarea, button, network, sends, checks, banners, type, page, warnings, getState: () => state };
}
type LoggedOutPage = Awaited<ReturnType<typeof loggedOutPage>>;

const enter = (p: LoggedOutPage) =>
  p.textarea.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

const entries = (b: unknown) => [...(b as URLSearchParams).entries()];

describe("adapter: the signed-out endpoint and body", () => {
  it("matches /unauth-mweb/conversation/updates with any query, not prepare or events", () => {
    expect(chatgptAdapter.isCompletionUrl(UPDATES)).toBe(true);
    expect(chatgptAdapter.isCompletionUrl("/unauth-mweb/conversation/updates")).toBe(true);
    expect(chatgptAdapter.isCompletionUrl("https://chatgpt.com" + PREPARE)).toBe(false);
    expect(chatgptAdapter.isCompletionUrl("https://chatgpt.com/unauth-mweb/events/business")).toBe(false);
    expect(chatgptAdapter.mayCarryPrompt!("https://chatgpt.com" + PREPARE)).toBe(true);
  });

  it("reads `prompt` from a URLSearchParams; none or two is unreadable", () => {
    expect(chatgptAdapter.getPrompt(updatesBody("hi there"))).toBe("hi there");
    expect(chatgptAdapter.getPrompt(prepareBody())).toBeNull();
    const two = updatesBody("a");
    two.append("prompt", "b");
    expect(chatgptAdapter.getPrompt(two)).toBeNull();
  });

  it("setPrompt: a NEW URLSearchParams, only `prompt` changed, every other entry identical and in order", () => {
    const input = updatesBody("my ssn is 123");
    const out = chatgptAdapter.setPrompt(input, "my ssn is [REDACTED]") as URLSearchParams;
    expect(Object.prototype.toString.call(out)).toBe("[object URLSearchParams]");
    expect(out).not.toBe(input);
    expect(input.get("prompt")).toBe("my ssn is 123"); // the page's object is untouched
    const a = entries(input);
    const b = entries(out);
    expect(b.map(([k]) => k)).toEqual(a.map(([k]) => k));
    for (let i = 0; i < a.length; i++) {
      if (a[i][0] === "prompt") expect(b[i][1]).toBe("my ssn is [REDACTED]");
      else expect(b[i][1]).toBe(a[i][1]);
    }
    for (const t of ["chatRequirementsToken", "proofToken", "turnstileToken", "telemetryToken", "timingToken"])
      expect(out.get(t)).toBe(input.get(t));
  });

  it("a string form body is read the same way and written back as a string", () => {
    const codec = chatgptAdapter.bodyCodec!(UPDATES)!;
    const raw = updatesBody("as a string").toString();
    const parsed = codec.decode(raw);
    expect(chatgptAdapter.getPrompt(parsed)).toBe("as a string");
    const enc = codec.encode(chatgptAdapter.setPrompt(parsed, "changed"), raw);
    expect(typeof enc).toBe("string");
    expect(new URLSearchParams(enc as string).get("prompt")).toBe("changed");
  });

  it("the logged-in endpoint keeps the JSON body (no form codec)", () => {
    expect(chatgptAdapter.bodyCodec!("https://chatgpt.com/backend-api/f/conversation")).toBeUndefined();
  });
});

describe("signed out, through the DOM: one check and one send per send", () => {
  it("allowed: 1 check, sent with the page's URLSearchParams body unchanged", async () => {
    const p = await loggedOutPage();
    p.type("how do I make banana bread?");
    p.button.click();
    expect(await until(() => p.sends().length > 0)).toBe(true);
    await settle(50);
    expect(p.checks).toEqual(["how do I make banana bread?"]);
    expect(p.sends()).toHaveLength(1);
    expect(entries(p.sends()[0].body)).toEqual(entries(updatesBody("how do I make banana bread?")));
    expect(Object.prototype.toString.call(p.sends()[0].body)).toBe("[object URLSearchParams]");
    expect(p.banners()).toEqual([]);
  });

  it("modify: 1 check, the outgoing params have `prompt` replaced and every other field identical, 1 modify banner", async () => {
    const p = await loggedOutPage({
      verdict: (t) => (t === "my ssn is 123-45-6789" ? v("modified", "my ssn is [REDACTED]") : v("allowed", t)),
    });
    p.type("my ssn is 123-45-6789");
    p.button.click();
    expect(await until(() => p.sends().length > 0)).toBe(true);
    await settle(50);
    expect(p.checks).toEqual(["my ssn is 123-45-6789"]);
    expect(p.sends()).toHaveLength(1);
    // The composer was rewritten so the SITE's own state carries the new text.
    expect(p.textarea.value).toBe("my ssn is [REDACTED]");
    expect(p.getState()).toBe("my ssn is [REDACTED]");
    const out = entries(p.sends()[0].body);
    const want = entries(updatesBody("my ssn is 123-45-6789"));
    expect(out.map(([k]) => k)).toEqual(want.map(([k]) => k));
    out.forEach(([k, val], i) => expect(val).toBe(k === "prompt" ? "my ssn is [REDACTED]" : want[i][1]));
    expect(p.banners().map((b) => b.kind)).toEqual(["modify"]);
  });

  it("block: not sent, no POST and no native submit, 1 block banner", async () => {
    const p = await loggedOutPage({ verdict: () => v("blocked", "Blocked by policy.") });
    p.type("please block me");
    p.button.click();
    await until(() => p.banners().length > 0);
    await settle(50);
    expect(p.checks).toHaveLength(1);
    expect(p.network).toEqual([]);
    expect(p.page.pageSubmits).toBe(0);
    expect(p.page.submits.every((e) => e.defaultPrevented)).toBe(true);
    expect(p.banners().map((b) => b.kind)).toEqual(["block"]);
    expect(p.textarea.value).toBe("please block me"); // composer keeps its text
  });

  for (const [name, send] of [
    ["Enter", enter],
    ["the send button", (p: LoggedOutPage) => p.button.click()],
    ["a form submit", (p: LoggedOutPage) => p.form.requestSubmit()],
  ] as const) {
    it(`${name}: exactly 1 check and 1 send`, async () => {
      const p = await loggedOutPage();
      p.type(`sent via ${name}`);
      send(p);
      expect(await until(() => p.sends().length > 0)).toBe(true);
      await settle(80);
      expect(p.checks).toEqual([`sent via ${name}`]);
      expect(p.sends()).toHaveLength(1);
      expect(p.page.pageSubmits).toBe(1); // only our re-send reached the site
    });
  }

  it("submit fired TWICE for one Enter (as captured): 1 check, 1 send, 1 banner", async () => {
    const p = await loggedOutPage({
      verdict: (t) => v("modified", t.replace("secret", "[REDACTED]")),
    });
    // The site's own Enter handling, ahead of ours, submits twice.
    p.win.addEventListener(
      "keydown",
      (e) => {
        if ((e as KeyboardEvent).key !== "Enter") return;
        p.form.requestSubmit();
        p.form.requestSubmit();
      },
      true,
    );
    p.type("a secret word");
    enter(p);
    expect(p.page.submits).toHaveLength(2);
    expect(p.page.submits.every((e) => e.defaultPrevented)).toBe(true); // no native POST
    expect(await until(() => p.sends().length > 0)).toBe(true);
    await settle(80);
    expect(p.checks).toEqual(["a secret word"]);
    expect(p.sends()).toHaveLength(1);
    expect((p.sends()[0].body as URLSearchParams).get("prompt")).toBe("a [REDACTED] word");
    expect(p.banners().map((b) => b.kind)).toEqual(["modify"]);
  });

  it("two submit events dispatched for one send: 1 check", async () => {
    const p = await loggedOutPage();
    p.type("double submit");
    for (let i = 0; i < 2; i++) p.form.dispatchEvent(new p.win.Event("submit", { bubbles: true, cancelable: true }));
    expect(await until(() => p.sends().length > 0)).toBe(true);
    await settle(80);
    expect(p.checks).toEqual(["double submit"]);
    expect(p.sends()).toHaveLength(1);
  });

  it("three sends in a row = three checks, three sends", async () => {
    const p = await loggedOutPage();
    for (const t of ["first", "second", "third"]) {
      p.type(t);
      enter(p);
      await until(() => p.checks.length > 0 && p.sends().length === p.checks.length);
      await settle(30);
    }
    expect(p.checks).toEqual(["first", "second", "third"]);
    expect(p.sends().map((s) => (s.body as URLSearchParams).get("prompt"))).toEqual(["first", "second", "third"]);
  });
});

describe("signed out, fetch hook alone (no DOM send)", () => {
  it("a programmatic POST to updates: 1 check, sent", async () => {
    const p = await loggedOutPage();
    const body = updatesBody("programmatic only");
    await p.win.fetch(UPDATES, { method: "POST", body });
    expect(p.checks).toEqual(["programmatic only"]);
    expect(p.network).toHaveLength(1);
    expect(p.network[0].body).toBe(body);
  });

  it("a programmatic POST to updates that is blocked: rejected, nothing sent", async () => {
    const p = await loggedOutPage({ verdict: () => v("blocked", "Blocked by policy.") });
    await expect(p.win.fetch(UPDATES, { method: "POST", body: updatesBody("block me") })).rejects.toThrow();
    expect(p.checks).toEqual(["block me"]);
    expect(p.network).toEqual([]);
  });

  it("modify through the hook keeps the URLSearchParams type, the other fields, and the headers", async () => {
    const p = await loggedOutPage({ verdict: () => v("modified", "clean") });
    const headers = { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" };
    const body = updatesBody("dirty");
    await p.win.fetch(UPDATES, { method: "POST", body, headers });
    const sent = p.network[0];
    expect(Object.prototype.toString.call(sent.body)).toBe("[object URLSearchParams]");
    expect(sent.init?.headers).toBe(headers);
    const want = entries(body);
    entries(sent.body).forEach(([k, val], i) => {
      expect(k).toBe(want[i][0]);
      expect(val).toBe(k === "prompt" ? "clean" : want[i][1]);
    });
  });

  it("a string form body is checked and re-sent as a string", async () => {
    const p = await loggedOutPage({ verdict: () => v("modified", "clean") });
    await p.win.fetch(UPDATES, { method: "POST", body: updatesBody("dirty").toString() });
    expect(p.checks).toEqual(["dirty"]);
    expect(typeof p.network[0].body).toBe("string");
    expect(new URLSearchParams(p.network[0].body as string).get("prompt")).toBe("clean");
  });

  it("prepare with no prompt field: not checked, passes through untouched", async () => {
    const p = await loggedOutPage({ failPolicy: "closed" });
    const body = prepareBody();
    await p.win.fetch(PREPARE, { method: "POST", body });
    expect(p.checks).toEqual([]);
    expect(p.network).toHaveLength(1);
    expect(p.network[0].body).toBe(body);
    expect(p.banners()).toEqual([]);
    expect(p.warnings).toEqual([]); // not an error: a pre-flight with nothing to check
  });

  it("prepare that DOES carry a prompt: that text is checked, and a block stops it", async () => {
    const p = await loggedOutPage({ verdict: () => v("blocked", "Blocked by policy.") });
    const body = prepareBody();
    body.append("prompt", "smuggled text");
    await expect(p.win.fetch(PREPARE, { method: "POST", body })).rejects.toThrow();
    expect(p.checks).toEqual(["smuggled text"]);
    expect(p.network).toEqual([]);
  });

  it("a prepare carrying already-checked text does not spend the preapproval the send needs", async () => {
    const p = await loggedOutPage();
    p.doc.dispatchEvent(new p.win.CustomEvent(PREAPPROVE_EVENT, { detail: "checked by the DOM" }));
    const prep = prepareBody();
    prep.append("prompt", "checked by the DOM");
    await p.win.fetch(PREPARE, { method: "POST", body: prep });
    await p.win.fetch(UPDATES, { method: "POST", body: updatesBody("checked by the DOM") });
    expect(p.checks).toEqual([]);
    expect(p.network).toHaveLength(2);
  });
});

describe("signed out, unreadable body", () => {
  const unreadable = () => [
    ["no prompt field", prepareBody()],
    ["a Blob", new Blob(["prompt=x"])],
  ] as const;

  for (const [what, body] of unreadable()) {
    it(`fail-closed blocks (${what})`, async () => {
      const p = await loggedOutPage({ failPolicy: "closed" });
      await expect(p.win.fetch(UPDATES, { method: "POST", body })).rejects.toThrow();
      expect(p.network).toEqual([]);
      await settle(20);
      expect(p.banners()).toEqual([{ kind: "block", text: expect.stringContaining(UNREADABLE_BLOCK_MESSAGE) }]);
    });

    it(`fail-open passes with a warning (${what})`, async () => {
      const p = await loggedOutPage({ failPolicy: "open" });
      await p.win.fetch(UPDATES, { method: "POST", body });
      expect(p.network).toHaveLength(1);
      expect(p.checks).toEqual([]);
      await settle(20);
      expect(p.banners().map((b) => b.kind)).toEqual(["warn"]);
      expect(p.warnings.some((w) => w.includes("fetch hook error"))).toBe(true);
    });
  }
});

describe("self-test", () => {
  it("finds the signed-out composer", async () => {
    const p = await loggedOutPage();
    expect(chatgptAdapter.selfTest(p.doc).composerFound).toBe(true);
    expect(p.warnings.some((w) => w.includes("composer NOT found"))).toBe(false);
  });
});

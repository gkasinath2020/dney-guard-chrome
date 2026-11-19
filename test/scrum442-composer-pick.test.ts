// SCRUM-442: on real signed-in chatgpt.com (15 Oct, GK), a reply rendered an
// editable email-draft card. The DOM layer took the FIRST composer-selector match
// in document order, which was the card, so every later send checked the card's
// 157 chars instead of the user's message (the fetch hook alone checked the real
// text). These run the REAL content scripts in a jsdom page with such a card placed
// BEFORE the composer, as on the real page.
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error -- jsdom ships no types and @types/jsdom is not a dependency
import { JSDOM } from "jsdom";
import { buildContentScripts, settle } from "./helpers/page-env";
import { DEFAULT_CONFIG } from "../src/lib/config";
import { pickComposer, pickSendButton } from "../src/lib/composer-pick";
import type { Config, Verdict } from "../src/lib/types";

const SEND_URL = "https://chatgpt.com/backend-api/f/conversation";
const CARD_TEXT = "Hi,\n\nI'm sorry, but I won't be able to make the meeting as planned.\n\nBest regards,\n[Your Name]";

let scripts: { main: string; hook: string };
beforeAll(async () => {
  scripts = await buildContentScripts();
});

function v(action: Verdict["action"], text: string): Verdict {
  return { action, text, original_text: text, rails_triggered: [], latency_ms: 1, failed: false };
}

/**
 * Signed-in ChatGPT, after a reply that carries an editable card.
 * - `cardSharesId`: the card's editor reuses id="prompt-textarea" (a duplicate id).
 * - otherwise the composer has NO id, so only the ProseMirror fallback finds it.
 * Either way the card is first in document order.
 */
async function signedInPage(opts: { cardSharesId: boolean; verdict?: (t: string) => Verdict }) {
  const cardId = opts.cardSharesId ? ' id="prompt-textarea"' : "";
  const composerId = opts.cardSharesId ? ' id="prompt-textarea"' : "";
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <main>
        <article data-testid="conversation-turn-2">
          <div data-message-author-role="assistant">
            <div class="email-card"><div${cardId} contenteditable="true" class="ProseMirror" tabindex="0"></div>
            <button aria-label="Connect email">Connect email</button></div>
          </div>
        </article>
        <form class="composer">
          <div${composerId} contenteditable="true" class="ProseMirror" tabindex="0"></div>
          <button data-testid="send-button" aria-label="Send prompt" type="button">Send</button>
        </form>
      </main></body></html>`,
    { url: "https://chatgpt.com/c/abc", runScripts: "outside-only" },
  );
  const win = dom.window as unknown as Window & typeof globalThis;
  const doc = win.document;
  win.postMessage = ((data: unknown) => {
    setTimeout(() => win.dispatchEvent(new win.MessageEvent("message", { data, source: win })), 0);
  }) as typeof win.postMessage;
  const sent: string[] = [];
  win.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("/backend-api/f/conversation")) {
      sent.push(JSON.parse(String(init?.body)).messages[0].content.parts[0]);
    }
    return new Response("ok");
  }) as typeof fetch;
  (win as unknown as { console: Console }).console = { ...console, debug() {}, warn() {} } as Console;
  // jsdom has no execCommand: the modify path's selectAll + insertText edits the focused editable.
  (doc as unknown as { execCommand: unknown }).execCommand = (cmd: string, _ui: boolean, value?: string) => {
    if (cmd === "insertText" && doc.activeElement) doc.activeElement.textContent = value ?? "";
    return true;
  };

  const checks: string[] = [];
  const config: Config = { ...DEFAULT_CONFIG, api_key: "k", fail_policy: "open" };
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

  const [card, composer] = [...doc.querySelectorAll('div[contenteditable="true"]')] as HTMLElement[];
  card.textContent = CARD_TEXT;
  const sendBtn = doc.querySelector('[data-testid="send-button"]') as HTMLButtonElement;
  // The site's own send: reads its composer (not the card) and POSTs it.
  sendBtn.addEventListener("click", () => {
    void win.fetch(SEND_URL, {
      method: "POST",
      body: JSON.stringify({ messages: [{ content: { content_type: "text", parts: [composer.textContent] } }] }),
    });
  });

  const run = (code: string, c?: unknown) =>
    (win as unknown as { eval(c: string): (c: unknown) => void }).eval(`(function (chrome) {${code}\n})`)(c);
  run(scripts.main, chrome);
  run(scripts.hook);
  await settle(30);

  const banners = () =>
    [...doc.querySelectorAll(".dney-banner")].map((b) => [...b.classList].find((c) => c !== "dney-banner")).filter((k) => k !== "checking");
  return { win, doc, card, composer, sendBtn, sent, checks, banners };
}

describe.each([
  ["the card's editor reuses id=prompt-textarea", true],
  ["the composer has no id (fallback selector)", false],
])("a reply's editable card BEFORE the composer: %s", (_n, cardSharesId) => {
  it("send: the COMPOSER text is checked, once, and sent; the card is untouched", async () => {
    const p = await signedInPage({ cardSharesId });
    p.composer.textContent = "hello there";
    p.sendBtn.click();
    await settle(60);
    expect(p.checks).toEqual(["hello there"]);
    expect(p.sent).toEqual(["hello there"]);
    expect(p.card.textContent).toBe(CARD_TEXT);
  });

  it("modify: one check of the composer text; the composer gets the masked text, never the card", async () => {
    const p = await signedInPage({
      cardSharesId,
      verdict: (t) => (t === "mail a@b.co" ? v("modified", "mail [EMAIL]") : v("allowed", t)),
    });
    p.composer.textContent = "mail a@b.co";
    p.sendBtn.click();
    await settle(60);
    expect(p.checks).toEqual(["mail a@b.co"]);
    expect(p.sent).toEqual(["mail [EMAIL]"]);
    expect(p.composer.textContent).toBe("mail [EMAIL]");
    expect(p.card.textContent).toBe(CARD_TEXT);
    expect(p.banners()).toEqual(["modify"]);
  });

  it("the card has FOCUS when the user clicks send: the composer text is what is checked", async () => {
    const p = await signedInPage({ cardSharesId });
    p.card.focus();
    p.composer.textContent = "from the composer";
    p.sendBtn.click();
    await settle(60);
    expect(p.checks).toEqual(["from the composer"]);
    expect(p.card.textContent).toBe(CARD_TEXT);
  });

  it("the user edited the card, then sent from the composer: only the composer text is checked", async () => {
    const p = await signedInPage({ cardSharesId });
    p.card.textContent = "Hi, edited by the user";
    p.composer.textContent = "composer message";
    p.sendBtn.click();
    await settle(60);
    expect(p.checks).toEqual(["composer message"]);
    expect(p.card.textContent).toBe("Hi, edited by the user");
  });

  it("Enter inside the card is not a composer send: no check", async () => {
    const p = await signedInPage({ cardSharesId });
    p.card.dispatchEvent(new p.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle(30);
    expect(p.checks).toEqual([]);
  });
});

describe("signed-in FRESH page (Assay, real site 15 Oct): no #prompt-textarea, send is aria-label \"Send\"", () => {
  it("a 'Send feedback' button earlier on the page is not the send button; the in-form editor is the composer", () => {
    const d = new JSDOM(`<!doctype html><body>
      <nav><button aria-label="Send feedback" id="fb"></button></nav>
      <form><div contenteditable="true" class="ProseMirror" id="c"></div><button aria-label="Send" id="s"></button></form>
    </body>`).window.document as Document;
    const sel = 'button[data-testid="send-button"], button[data-composer-submit], button[aria-label*="Send" i]';
    const fallback = 'div[contenteditable="true"].ProseMirror, textarea#mobile-composer-prompt, textarea[data-mobile-composer-prompt]';
    const btn = pickSendButton(d, sel, ["#prompt-textarea", fallback]);
    expect(btn?.id).toBe("s");
    expect(pickComposer(d, ["#prompt-textarea", fallback], btn)?.id).toBe("c");
  });
});

describe("pickComposer / pickSendButton (pure)", () => {
  const page = (html: string) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document as Document;

  it("prefers the candidate in the send button's form, even when another comes first", () => {
    const d = page(`<div class="ProseMirror" id="a"></div><form><div class="ProseMirror" id="b"></div><button id="s"></button></form>`);
    expect(pickComposer(d, [".ProseMirror"], d.getElementById("s"))?.id).toBe("b");
  });

  it("with no send button, the first candidate outside a conversation turn", () => {
    const d = page(`<article><div class="ProseMirror" id="a"></div></article><div class="ProseMirror" id="b"></div>`);
    expect(pickComposer(d, [".ProseMirror"], null)?.id).toBe("b");
  });

  it("only candidates inside conversation turns -> none (the fetch hook checks instead)", () => {
    const d = page(`<div data-message-author-role="assistant"><div class="ProseMirror"></div></div>`);
    expect(pickComposer(d, [".ProseMirror"], null)).toBeNull();
  });

  it("selector priority holds among valid candidates", () => {
    const d = page(`<div class="fb" id="f"></div><div id="prompt-textarea"></div>`);
    expect(pickComposer(d, ["#prompt-textarea", ".fb"], null)?.id).toBe("prompt-textarea");
  });

  it("a send-like button inside a reply is never the send button", () => {
    const d = page(`<article><button aria-label="Send email" id="x"></button></article><form><button aria-label="Send prompt" id="s"></button></form>`);
    expect(pickSendButton(d, 'button[aria-label*="Send" i]')?.id).toBe("s");
  });
});

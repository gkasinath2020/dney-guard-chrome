// chatgpt.com site adapter. Values captured from a live probe on 2026-08-01 —
// see docs/adapter-chatgpt-findings.md. INPUT rail only: the prompt lives at
// messages[last].content.parts[0]. The OUTPUT rail is deferred — ChatGPT streams a
// compressed delta-encoding (JSON-patch) format that is far harder to buffer +
// synthesize than claude.ai's plain Anthropic SSE (sse.outputSupported = false).
//
// SIGNED OUT, chatgpt.com is a different app (captured 2026-10-15): a plain
// <textarea id="mobile-composer-prompt"> in a real <form>, and the send is
// POST /unauth-mweb/conversation/updates with a URLSearchParams body whose
// top-level `prompt` field is the text (conversationState.messages is empty).
import type { BodyCodec, SiteAdapter } from "./adapter-types";

// POST /backend-api/conversation  or  /backend-api/f/conversation
const CONVERSATION_RE = /\/backend-api\/(?:f\/)?conversation(?:\?|$)/i;
// Signed out: POST /unauth-mweb/conversation/updates?lightweight_authenticated=0&operationId=…
const UNAUTH_SEND_RE = /\/unauth-mweb\/conversation\/updates(?:\?|$)/i;
// Signed out: the pre-flight that fires on load and after each turn. No prompt in
// any capture, but if it ever carries one, that text is checked too.
const UNAUTH_PREPARE_RE = /\/unauth-mweb\/conversation\/prepare(?:\?|$)/i;
// Signed in: POST /backend-api/f/conversation/prepare fires while the user types
// (client_prepare_source "composer_editor_state") with `partial_query` = the draft
// as a message object. ChatGPT itself sends partial_query: null on other prepares.
const PREPARE_RE = /\/backend-api\/(?:f\/)?conversation\/prepare(?:\?|$)/i;

const isParams = (b: unknown): b is URLSearchParams =>
  Object.prototype.toString.call(b) === "[object URLSearchParams]";

/**
 * Signed-out bodies: a URLSearchParams OBJECT (as captured), or the same as a
 * string. Decoded to a copy; a modified body goes back as the type it came in.
 */
const FORM_BODY: BodyCodec = {
  decode(body) {
    if (isParams(body)) return new URLSearchParams(body);
    if (typeof body === "string") return new URLSearchParams(body);
    throw new Error("body is not form data");
  },
  encode(parsed, original) {
    return typeof original === "string" ? String(parsed) : (parsed as URLSearchParams);
  },
};

/** The last message's text content, when it is a plain-text turn. */
function lastTextMessage(body: unknown): { parts: unknown[]; idx: number } | null {
  const b = body as any;
  const msgs = b?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const last = msgs[msgs.length - 1];
  if (last?.content?.content_type !== "text" || !Array.isArray(last.content.parts)) return null;
  return { parts: last.content.parts, idx: msgs.length - 1 };
}

export const chatgptAdapter: SiteAdapter = {
  site: "chatgpt.com",
  surface: "chatgpt-web",

  isCompletionUrl(url: string): boolean {
    return typeof url === "string" && (CONVERSATION_RE.test(url) || UNAUTH_SEND_RE.test(url));
  },

  bodyCodec(url: string): BodyCodec | undefined {
    return /\/unauth-mweb\//i.test(url) ? FORM_BODY : undefined;
  },

  mayCarryPrompt(url: string): boolean {
    return typeof url === "string" && UNAUTH_PREPARE_RE.test(url);
  },

  // The draft never leaves before the send (the send itself is checked as usual).
  // A body that is not a JSON-object string is returned undefined: passed through.
  stripDraft(url: string, body: unknown): unknown | undefined {
    if (typeof url !== "string" || !PREPARE_RE.test(url) || typeof body !== "string") return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const b = parsed as Record<string, unknown>;
    if (!("partial_query" in b) || b.partial_query === null) return body; // nothing to strip
    return JSON.stringify({ ...b, partial_query: null });
  },

  getPrompt(body: unknown): string | null {
    if (isParams(body)) {
      // Exactly one `prompt` field; none, or two (which would we check?) is unreadable.
      const all = body.getAll("prompt");
      return all.length === 1 ? all[0] : null;
    }
    const m = lastTextMessage(body);
    const first = m?.parts[0];
    return typeof first === "string" ? first : null; // non-text (voice/image/tool) -> null -> pass through
  },

  setPrompt(body: unknown, text: string): unknown {
    if (isParams(body)) {
      // A NEW object: `prompt` replaced, every other field (the *Token fields
      // included) byte-identical and in the same order.
      const out = new URLSearchParams();
      for (const [k, v] of body) out.append(k, k === "prompt" ? text : v);
      return out;
    }
    const b = body as any;
    const m = lastTextMessage(body);
    if (!m) return body;
    // Immutable-ish clone of the messages array + the target message's parts.
    const messages = b.messages.map((msg: any, i: number) =>
      i === m.idx
        ? { ...msg, content: { ...msg.content, parts: [text, ...msg.content.parts.slice(1)] } }
        : msg,
    );
    return { ...b, messages };
  },

  // Compressed delta-encoding stream. Output-rail enforcement is NOT wired for
  // ChatGPT yet; extractDelta is best-effort for future use.
  sse: {
    deltaEvent: "delta",
    stopEvent: "[DONE]",
    eventNames: ["delta_encoding", "delta", "[DONE]"],
    extractDelta(data: unknown): string {
      const d = data as any;
      // append op to the assistant text path: { o: "append", p: ".../parts/0", v: "token" }
      if (d?.o === "append" && typeof d?.v === "string" && String(d?.p ?? "").includes("/parts/")) {
        return d.v;
      }
      // initial full value: { v: { message: { content: { parts: ["…"] } } } }
      const parts = d?.v?.message?.content?.parts;
      if (Array.isArray(parts) && typeof parts[0] === "string") return parts[0];
      return "";
    },
    outputSupported: false,
  },

  selectors: {
    composer: "#prompt-textarea",
    // Signed out: <textarea id="mobile-composer-prompt" data-mobile-composer-prompt>.
    composerFallback:
      'div[contenteditable="true"].ProseMirror, textarea#mobile-composer-prompt, textarea[data-mobile-composer-prompt]',
    sendButton:
      'button[data-testid="send-button"], button[data-composer-submit], button[aria-label*="Send" i]',
  },

  selfTest(doc: Document): { composerFound: boolean } {
    const found = !!(
      doc.querySelector(this.selectors.composer) ||
      doc.querySelector(this.selectors.composerFallback)
    );
    return { composerFound: found };
  },
};

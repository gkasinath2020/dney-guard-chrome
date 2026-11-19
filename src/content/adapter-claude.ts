// The ONLY site-specific module. Everything claude.ai-specific lives here so the
// rest of the extension is site-agnostic (a chatgpt.ts adapter could be added
// later). Values captured from a live probe on 2026-07-31 — see
// docs/adapter-claude-findings.md. Treat as config + self-test (the frontend is
// unversioned and will change; spec §8).
import type { SiteAdapter } from "./adapter-types";

// POST /api/organizations/{orgUuid}/chat_conversations/{convUuid}/completion
const COMPLETION_RE =
  /\/api\/organizations\/[0-9a-f-]+\/chat_conversations\/[0-9a-f-]+\/completion(?:\?|$)/i;

// SCRUM-452 (Assay, 19 Oct): claude.ai now sends messages as binary protobuf over
// Connect-RPC; the hook can neither read nor rewrite it.
const PERFORM_ACTION_RE = /\/claudeai-rpc\/[^?]*ConversationService\/PerformAction(?:\?|$)/i;

export const claudeAdapter: SiteAdapter = {
  site: "claude.ai",
  surface: "claude-web",
  cannotRewriteSend: true,

  isUnobservedSendUrl(url: string): boolean {
    return typeof url === "string" && PERFORM_ACTION_RE.test(url);
  },

  isCompletionUrl(url: string): boolean {
    return typeof url === "string" && COMPLETION_RE.test(url);
  },

  // Prompt text lives at the top-level `prompt` string field of the completion body.
  getPrompt(body: unknown): string | null {
    if (body && typeof body === "object" && typeof (body as any).prompt === "string") {
      return (body as any).prompt as string;
    }
    return null;
  },

  setPrompt(body: unknown, text: string): unknown {
    return { ...(body as object), prompt: text };
  },

  // Anthropic Messages-API SSE grammar (captured live).
  sse: {
    deltaEvent: "content_block_delta",
    stopEvent: "message_stop",
    eventNames: [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_limit",
      "message_stop",
    ],
    // content_block_delta payload: { type, index, delta: { type: "text_delta", text } }
    extractDelta(data: unknown): string {
      const d = data as any;
      return (d?.delta?.text as string) ?? "";
    },
    outputSupported: false, // output rail (buffer-and-release) = Phase D
  },

  selectors: {
    composer: 'div[contenteditable="true"].ProseMirror',
    composerFallback: '[aria-label="Write your prompt to Claude"]',
    sendButton: 'button[aria-label="Send message"]',
  },

  // §8 self-test: on load, confirm the composer selector resolves. The endpoint
  // pattern is validated passively against the first observed completion POST.
  selfTest(doc: Document): { composerFound: boolean } {
    const found = !!(
      doc.querySelector(this.selectors.composer) ||
      doc.querySelector(this.selectors.composerFallback)
    );
    return { composerFound: found };
  },
};

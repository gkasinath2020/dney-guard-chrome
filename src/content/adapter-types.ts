// Site-adapter contract. Each supported site (claude.ai, chatgpt.com, …)
// implements this; everything else in the extension is site-agnostic.

export interface SiteAdapter {
  site: string;
  /** Surface tag sent to DNey (audit attribution): "claude-web" | "chatgpt-web". */
  surface: string;
  /** True for the site's message-send (completion) request URL. */
  isCompletionUrl(url: string): boolean;
  /** Extract the user prompt text from the send-request body, or null. */
  getPrompt(body: unknown): string | null;
  /** Return a new body with the prompt replaced (for `modified`). */
  setPrompt(body: unknown, text: string): unknown;
  /**
   * How the fetch hook reads and re-writes this URL's body. Absent/undefined: a
   * JSON string, parsed and re-serialised by the hook itself. Otherwise
   * getPrompt/setPrompt work on whatever `decode` returns.
   */
  bodyCodec?(url: string): BodyCodec | undefined;
  /**
   * A non-send request that MAY carry a prompt (e.g. a pre-flight). Checked only
   * when it does; with no prompt, or a body the codec cannot read, it passes.
   */
  mayCarryPrompt?(url: string): boolean;
  /**
   * A request the site sends WHILE the user is still typing, carrying the draft.
   * Returns the body with the draft removed (same type), or undefined when `url`
   * is not such a request or the body is not one this adapter can read. The hook
   * never checks a draft; it strips it, so nothing leaves before the real send.
   */
  stripDraft?(url: string, body: unknown): unknown | undefined;
  /**
   * SCRUM-452: true when this site sends messages through a channel the hook
   * cannot read or rewrite (claude.ai's binary Connect-RPC), so a DOM-layer
   * "modify" cannot be guaranteed to reach what is sent. The DOM layer then
   * BLOCKS such a send instead of masking it (fail closed).
   */
  cannotRewriteSend?: boolean;
  /**
   * SCRUM-452 tripwire: the URL of a send the hook cannot read. The hook warns
   * (console, once per page) when one fires with no DOM-layer verdict just
   * before it: a send path the DOM layer did not intercept went out unchecked.
   */
  isUnobservedSendUrl?(url: string): boolean;
  /** Response SSE grammar (used by the output rail, which may be site-specific). */
  sse: {
    deltaEvent: string;
    stopEvent: string;
    eventNames: string[];
    extractDelta(data: unknown): string;
    /** True if the output rail is implemented for this site. */
    outputSupported: boolean;
  };
  selectors: { composer: string; composerFallback: string; sendButton: string };
  selfTest(doc: Document): { composerFound: boolean };
}

/** Reads a completion request body, and writes a modified one back as the same type. */
export interface BodyCodec {
  /** The parsed body for getPrompt/setPrompt. Throws if this body cannot be read. */
  decode(body: unknown): unknown;
  /** Re-serialise `parsed` as the same type as `original` (what the page sent). */
  encode(parsed: unknown, original: unknown): BodyInit;
}


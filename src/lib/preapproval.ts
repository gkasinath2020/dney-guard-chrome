// SCRUM-329: the DOM layer's "this text was already checked" hand-off to the
// MAIN-world fetch hook (§4.3 double-check suppression).
//
// It used to travel by window.postMessage, which is delivered in a LATER task.
// The re-send's btn.click() makes the page call fetch SYNCHRONOUSLY, in the same
// task, so the hook saw the completion before it saw the preapproval and checked
// every allowed/modified send a second time (3 sends = 6 checks). A DOM event
// dispatched on `document` is seen by listeners in both worlds before
// dispatchEvent returns, so the hook has it before the click even starts. Only a
// primitive `detail` crosses the world boundary reliably, so it is a string.
//
// A preapproval is ONE-SHOT and expires: it covers the one send the DOM layer
// just checked, never "the next completion whatever it says". Text that differs
// beyond whitespace is checked again — the page or the user can change it
// between the check and the send.

export const PREAPPROVE_EVENT = "dney-guard-preapprove";
export const PREAPPROVAL_TTL_MS = 10_000;

/**
 * Whitespace-insensitive form of a prompt. The DOM layer reads the composer's
 * innerText; the site serialises the body itself (e.g. "\n\n" vs "\n" between
 * paragraphs). Runs of any whitespace (incl. nbsp) become one space.
 */
export function normalizePrompt(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** ISOLATED world: tell the hook, synchronously, that `text` was just checked. */
export function sendPreapproval(text: string, doc: Document = document): void {
  doc.dispatchEvent(new CustomEvent(PREAPPROVE_EVENT, { detail: text }));
}

export interface Preapprovals {
  add(text: string): void;
  /** True (and spent) if `text` matches a live preapproval. */
  consume(text: string): boolean;
  /** True if `text` matches a live preapproval; does not spend it. */
  has(text: string): boolean;
}

export function createPreapprovals(now: () => number = Date.now): Preapprovals {
  const live: { text: string; expires: number }[] = [];
  const prune = () => {
    const t = now();
    for (let i = live.length - 1; i >= 0; i--) if (live[i].expires <= t) live.splice(i, 1);
  };
  return {
    add(text) {
      prune();
      const n = normalizePrompt(text);
      if (n) live.push({ text: n, expires: now() + PREAPPROVAL_TTL_MS });
    },
    consume(text) {
      prune();
      const i = live.findIndex((e) => e.text === normalizePrompt(text));
      if (i < 0) return false;
      live.splice(i, 1);
      return true;
    },
    has(text) {
      prune();
      return live.some((e) => e.text === normalizePrompt(text));
    },
  };
}

/** MAIN world: record every preapproval event into `store`. */
export function listenForPreapprovals(store: Preapprovals, doc: Document = document): void {
  doc.addEventListener(PREAPPROVE_EVENT, (ev) => {
    const detail = (ev as CustomEvent).detail;
    if (typeof detail === "string") store.add(detail);
  });
}

// SCRUM-441: the MODIFY path's hand-off. The DOM layer writes the masked text into
// the composer before it re-sends, but signed-in ChatGPT's ProseMirror composer
// can still send the ORIGINAL text (the edit has not reached the page's own state
// by the click). The masked preapproval then matched nothing, so the hook checked
// the original a second time and showed a second banner. So the DOM layer also
// says "the original became this": a body that still carries the original is
// rewritten to the masked text with no second check. Same one-shot + TTL rules.
export const REWRITE_EVENT = "dney-guard-rewrite";

/** ISOLATED world: tell the hook, synchronously, that `from` was checked and became `to`. */
export function sendRewrite(from: string, to: string, doc: Document = document): void {
  doc.dispatchEvent(new CustomEvent(REWRITE_EVENT, { detail: JSON.stringify({ from, to }) }));
}

export interface Rewrites {
  add(from: string, to: string): void;
  /** The masked text if `text` matches a live rewrite (and spends it), else null. */
  take(text: string): string | null;
  /** As take, without spending it (a pre-flight before the real send). */
  peek(text: string): string | null;
  /** The send carried the masked text itself: drop the rewrite that produced it. */
  dropTo(masked: string): void;
}

export function createRewrites(now: () => number = Date.now): Rewrites {
  const live: { from: string; to: string; expires: number }[] = [];
  const prune = () => {
    const t = now();
    for (let i = live.length - 1; i >= 0; i--) if (live[i].expires <= t) live.splice(i, 1);
  };
  const find = (text: string) => {
    prune();
    const n = normalizePrompt(text);
    return n ? live.findIndex((e) => e.from === n) : -1;
  };
  return {
    add(from, to) {
      prune();
      const n = normalizePrompt(from);
      if (n && to) live.push({ from: n, to, expires: now() + PREAPPROVAL_TTL_MS });
    },
    take(text) {
      const i = find(text);
      if (i < 0) return null;
      return live.splice(i, 1)[0].to;
    },
    peek(text) {
      const i = find(text);
      return i < 0 ? null : live[i].to;
    },
    dropTo(masked) {
      prune();
      const n = normalizePrompt(masked);
      const i = live.findIndex((e) => normalizePrompt(e.to) === n);
      if (i >= 0) live.splice(i, 1);
    },
  };
}

/** MAIN world: record every rewrite event into `store`. */
export function listenForRewrites(store: Rewrites, doc: Document = document): void {
  doc.addEventListener(REWRITE_EVENT, (ev) => {
    const detail = (ev as CustomEvent).detail;
    if (typeof detail !== "string") return;
    try {
      const { from, to } = JSON.parse(detail) as { from?: unknown; to?: unknown };
      if (typeof from === "string" && typeof to === "string") store.add(from, to);
    } catch {
      /* malformed: ignore, the hook checks as usual */
    }
  });
}

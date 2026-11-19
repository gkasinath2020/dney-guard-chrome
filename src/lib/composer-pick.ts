// SCRUM-442: which editable on the page is THE composer.
//
// The DOM layer used to take the first element in document order that matched the
// adapter's composer selector. On signed-in ChatGPT a reply can render its own
// editable (an email-draft or canvas card) that matches too, and it comes BEFORE the
// composer in document order. The DOM layer then checked the card's text instead of
// the user's message on every send, leaving the fetch hook as the only real check.
//
// The composer is the editable that lives with the send button (same <form>), and it
// is never inside a conversation turn. With no candidate that qualifies, there is no
// composer: the DOM layer stands aside and the fetch hook checks the real request.

/** Containers that hold a conversation turn (a message, or a reply's widgets). */
export const IN_TURN =
  'article, [data-message-author-role], [data-testid^="conversation-turn"]';

function inTurn(el: Element): boolean {
  return el.closest(IN_TURN) !== null;
}

/** Every element matching any selector, in document order, without duplicates. */
function matches(doc: Document, selectors: string[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sel of selectors) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(sel))) {
      if (!out.includes(el)) out.push(el);
    }
  }
  return out;
}

/**
 * The send button: a match that is not part of a conversation turn, preferring
 * one in a <form> that also holds a composer candidate (signed-in ChatGPT's is
 * just aria-label "Send", so a "Send feedback" elsewhere on the page matches too).
 */
export function pickSendButton(
  doc: Document,
  selector: string,
  composerSelectors: string[] = [],
): HTMLButtonElement | null {
  const buttons = matches(doc, [selector]).filter((el) => !inTurn(el));
  const editors = matches(doc, composerSelectors).filter((el) => !inTurn(el));
  const withComposer = buttons.find((b) => {
    const form = b.closest("form");
    return !!form && editors.some((e) => form.contains(e));
  });
  return ((withComposer ?? buttons[0]) as HTMLButtonElement) ?? null;
}

/**
 * The composer: among the matches for `selectors` (in priority order), the one that
 * shares a <form> with `sendButton`; failing that, the first one outside every
 * conversation turn; failing that, none.
 */
export function pickComposer(
  doc: Document,
  selectors: string[],
  sendButton: Element | null,
): HTMLElement | null {
  const candidates = matches(doc, selectors).filter((el) => !inTurn(el));
  const form = sendButton?.closest("form");
  if (form) {
    const withButton = candidates.find((el) => form.contains(el));
    if (withButton) return withButton;
  }
  return candidates[0] ?? null;
}

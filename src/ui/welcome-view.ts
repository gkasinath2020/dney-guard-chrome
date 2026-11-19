// SCRUM-396: the welcome tab. Opened once after a popup signup (onboarding.ts).
// Static copy C1/C3/C4/C5 + a Try-it block (C2) that runs the REAL check with the
// stored key, through the service worker, and shows ONLY what that verdict said:
// the action, the protection named by rails_triggered (mapped onto the C4 names,
// protection-names.ts), and (when masked) the
// text the server returned. Nothing here is a canned result.
import type { TryResult } from "../lib/onboarding";
import { COPY, LINKS, fill } from "./onboarding-copy";
import { protectionName } from "./protection-names";

export interface WelcomeDeps {
  /** chrome.runtime.sendMessage, promisified. */
  send: (msg: unknown) => Promise<unknown>;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function externalLink(doc: Document, href: string, text: string, className?: string): HTMLAnchorElement {
  const a = el(doc, "a", { href, target: "_blank", rel: "noopener noreferrer", textContent: text });
  if (className) a.className = className;
  return a;
}

/**
 * The result line for a verdict, built ONLY from the verdict. A verdict that did
 * not complete, or a block/mask that names no protection, is "couldn't check":
 * the page never fills in a protection the server did not name.
 */
export function resultNodes(doc: Document, result: TryResult | null | undefined): HTMLElement[] {
  const failed = () => [el(doc, "p", { className: "result failed", textContent: COPY["C2.result_failed"] })];
  if (!result || !result.ok) return failed();
  const protection = protectionName(result.rails_triggered);
  switch (result.action) {
    case "allowed":
      return [el(doc, "p", { className: "result allowed", textContent: COPY["C2.result_allowed"] })];
    case "blocked":
      if (!protection) return failed();
      return [el(doc, "p", { className: "result blocked", textContent: fill(COPY["C2.result_blocked"], protection) })];
    case "modified":
      if (!protection) return failed();
      return [
        el(doc, "p", { className: "result masked", textContent: fill(COPY["C2.result_masked"], protection) }),
        el(doc, "blockquote", { className: "masked-text", id: "masked-text", textContent: result.text }),
      ];
    default:
      return failed();
  }
}

export function renderWelcome(root: HTMLElement, deps: WelcomeDeps): void {
  const doc = root.ownerDocument;
  doc.title = COPY["C.tab_title"];
  root.replaceChildren();

  // C2: Try it.
  const box = el(doc, "textarea", { id: "try-text", rows: 3 });
  const checkBtn = el(doc, "button", { id: "try-check", className: "primary", type: "button", textContent: COPY["C2.button"] });
  const resultSlot = el(doc, "div", { id: "try-result" });
  resultSlot.setAttribute("aria-live", "polite");
  const samples: [string, string][] = [
    [COPY["C2.sample_injection_button"], COPY["C2.sample_injection_text"]],
    [COPY["C2.sample_pii_button"], COPY["C2.sample_pii_text"]],
    [COPY["C2.sample_benign_button"], COPY["C2.sample_benign_text"]],
  ];
  const sampleRow = el(doc, "div", { className: "samples" });
  for (const [label, text] of samples) {
    const b = el(doc, "button", { type: "button", className: "sample", textContent: label });
    b.addEventListener("click", () => {
      box.value = text;
      resultSlot.replaceChildren();
    });
    sampleRow.append(b);
  }
  let busy = false;
  checkBtn.addEventListener("click", async () => {
    const text = box.value;
    if (busy || !text.trim()) return;
    busy = true;
    checkBtn.disabled = true;
    checkBtn.textContent = COPY["C2.checking"];
    resultSlot.replaceChildren();
    let result: TryResult | null = null;
    try {
      result = (await deps.send({ type: "dney-try-check", text })) as TryResult | null;
    } catch {
      result = null;
    }
    resultSlot.replaceChildren(...resultNodes(doc, result));
    busy = false;
    checkBtn.disabled = false;
    checkBtn.textContent = COPY["C2.button"];
  });

  const protection = (name: keyof typeof COPY, line: keyof typeof COPY) =>
    el(doc, "li", {}, el(doc, "strong", { textContent: COPY[name] }), ": ", COPY[line]);

  root.append(
    // C1
    el(
      doc,
      "section",
      { id: "c1" },
      el(doc, "h1", { textContent: COPY["C1.heading"] }),
      el(doc, "p", { className: "lead", textContent: COPY["C1.lead"] }),
    ),
    // C2
    el(
      doc,
      "section",
      { id: "c2", className: "card" },
      el(doc, "h2", { textContent: COPY["C2.heading"] }),
      el(doc, "p", { textContent: COPY["C2.intro"] }),
      sampleRow,
      el(doc, "label", { htmlFor: "try-text", textContent: COPY["C2.textbox_label"] }),
      box,
      checkBtn,
      resultSlot,
    ),
    // C3 ("Masked" is HELD until SCRUM-329/330: not rendered)
    el(
      doc,
      "section",
      { id: "c3" },
      el(doc, "h2", { textContent: COPY["C3.heading"] }),
      el(
        doc,
        "ul",
        { className: "banners" },
        el(doc, "li", {}, el(doc, "span", { className: "pill red", textContent: COPY["C3.blocked_label"] }), " ", COPY["C3.blocked_line"]),
        el(
          doc,
          "li",
          {},
          el(doc, "span", { className: "pill amber", textContent: COPY["C3.not_checked_label"] }),
          " ",
          COPY["C3.not_checked_line"],
        ),
      ),
    ),
    // C4
    el(
      doc,
      "section",
      { id: "c4" },
      el(doc, "h2", { textContent: COPY["C4.heading"] }),
      el(
        doc,
        "ul",
        { className: "protections" },
        protection("C4.injection_name", "C4.injection_line"),
        protection("C4.pii_name", "C4.pii_line"),
        protection("C4.exfil_name", "C4.exfil_line"),
      ),
      el(doc, "p", { textContent: COPY["C4.below"] }),
      externalLink(doc, LINKS.dashboard, COPY["C4.button"], "button-link"),
    ),
    // C5
    el(
      doc,
      "footer",
      { id: "c5" },
      el(doc, "p", {}, COPY["C5.footer"], " ", externalLink(doc, LINKS.privacy, COPY["C5.privacy_link"])),
    ),
  );
}

// Inline enforcement banners (§6). Injected by the ISOLATED content script into
// the claude.ai DOM. Styles are injected once as a <style> element (no external
// CSS — keeps the content script self-contained and CSP-safe).

const STYLE_ID = "dney-guard-style";
const HOST_ID = "dney-guard-banners";

const CSS = `
#${HOST_ID} { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; max-width: 560px; width: calc(100% - 32px); }
.dney-banner { font: 13px/1.45 system-ui, sans-serif; border-radius: 10px; padding: 10px 12px;
  display: flex; align-items: flex-start; gap: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.18); }
.dney-banner.block { background: #fbe9e7; border: 1px solid #c23b32; color: #5c1a15; }
.dney-banner.modify { background: #fbf1dd; border: 1px solid #b9791a; color: #5c3f0f; }
.dney-banner.warn { background: #fdf3e3; border: 1px solid #e0a13c; color: #5c3f0f; }
.dney-banner.checking { background: #e7f0fd; border: 1px solid #2f6fd6; color: #163b6e; }
.dney-banner .msg { flex: 1; }
.dney-banner .x { cursor: pointer; opacity: .6; font-weight: 700; background: none; border: 0; font-size: 14px; }
.dney-banner .x:hover { opacity: 1; }
`;

let guardObserver: MutationObserver | null = null;

function injectStyle(): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }
}

function ensureHost(): HTMLElement {
  injectStyle();
  // Resolve the host FRESH every call via getElementById (which only returns a
  // connected node) — never cache a reference, which can go stale/detached and
  // cause banners to be appended into an orphaned node (the MR-!7 regression).
  // Attach to <html>, not <body>: SPAs reconcile body's subtree; documentElement
  // is left alone.
  let host = document.getElementById(HOST_ID) as HTMLElement | null;
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    document.documentElement.appendChild(host);
  }
  // If the page ever strips our host/style, keep the style present; the host is
  // recreated on the next showBanner. (Top-level childList only — cheap.)
  if (!guardObserver) {
    guardObserver = new MutationObserver(() => injectStyle());
    guardObserver.observe(document.documentElement, { childList: true });
  }
  return host;
}

export type BannerKind = "block" | "modify" | "checking" | "warn";

/** Render a banner; returns the element so callers can remove it (e.g. the
 *  transient "checking" banner once a verdict arrives). */
export function showBanner(kind: BannerKind, text: string, autoDismissMs = 8000): HTMLElement {
  const host = ensureHost();
  const el = document.createElement("div");
  el.className = `dney-banner ${kind}`;
  el.setAttribute("role", kind === "block" || kind === "warn" ? "alert" : "status");

  const msg = document.createElement("span");
  msg.className = "msg";
  msg.textContent = text; // textContent — never innerHTML (no injection)
  el.appendChild(msg);

  if (kind !== "checking") {
    const close = document.createElement("button");
    close.className = "x";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => el.remove());
    el.appendChild(close);
  }

  host.appendChild(el);
  if (autoDismissMs > 0) setTimeout(() => el.remove(), autoDismissMs);
  return el;
}

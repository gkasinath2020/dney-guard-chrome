// SCRUM-433: the adapter self-test used to run once at DOMContentLoaded, before
// claude.ai / ChatGPT mount their React composer, so it warned on every healthy
// page load. Watch the DOM until the composer appears; warn only if it is still
// missing at the cap.

export const COMPOSER_WAIT_MS = 15_000;

/**
 * Call `onMissing` once if `found()` is still false after `capMs`. Stops
 * observing the moment `found()` is true, or at the cap.
 */
export function waitForComposer(
  doc: Document,
  found: () => boolean,
  onMissing: () => void,
  capMs = COMPOSER_WAIT_MS,
): void {
  if (found()) return;
  const observer = new MutationObserver(() => {
    if (!found()) return;
    observer.disconnect();
    clearTimeout(timer);
  });
  const timer = setTimeout(() => {
    observer.disconnect();
    if (!found()) onMissing();
  }, capMs);
  observer.observe(doc, { childList: true, subtree: true });
}

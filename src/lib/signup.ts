// SCRUM-395: sign up from the popup. Runs in the SERVICE WORKER only (the popup
// sends email + password over chrome.runtime and gets back an outcome id, never a
// token or a key), so host permissions apply and no page ever holds a credential.
//
// Flow: POST /api/v1/auth/signup -> {access_token} -> POST /api/v1/auth/api-keys
// with that token as Bearer -> store the returned key in chrome.storage.local ->
// the access token is DROPPED: it lives only in this function's locals, is never
// stored, never logged, never returned, and never sent anywhere but the one
// api-keys request on the configured DNey origin.

/** Sent as org_name (copy B2: "My workspace", renameable in the dashboard). */
export const SIGNUP_ORG_NAME = "My workspace";
/** The key's name in the dashboard, so the user can tell what created it. */
export const EXTENSION_KEY_NAME = "DNey Guard (Chrome)";
/** Attribution for new orgs from the popup (SCRUM-392 D tracking). */
export const SIGNUP_SOURCE = { channel: "extension" } as const;
/**
 * SCRUM-432: the Terms version the B2 notice shows, sent as terms_version_shown
 * ONLY by a signup whose surface rendered the notice. MUST equal the server's
 * terms_version (asgard-services config.py) and the web UI's TERMS_VERSION
 * (asgard-ui src/legal/terms.ts): the server records a terms_acceptances row only
 * when it equals its current version, and drops malformed values.
 */
export const TERMS_VERSION = "2026-10-14";
/** Per request. A signup creates an org and seeds three policies. */
export const SIGNUP_TIMEOUT_MS = 20000;

/** What the popup may learn. Each maps to exactly one pinned B3 string. */
export type SignupError =
  | "exists"
  | "invalid_email"
  | "password_short"
  | "password_long"
  | "throttled"
  | "unavailable"
  | "unknown";

export type SignupOutcome = { ok: true } | { ok: false; error: SignupError };

export interface SignupDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * Persists the key. In the extension: chrome.storage.local.set({ api_key,
   * api_key_id }); the id (SCRUM-437) lets a later popup sign-in revoke this key.
   */
  storeKey: (key: string, id?: string) => Promise<void>;
  timeoutMs?: number;
}

/** 502/503/504 are the service (or the load balancer in front of it) not answering. */
function isUnavailable(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

async function post(
  doFetch: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
  bearer?: string,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    return await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
      // No cookies, no cached credentials: the only credential is the one passed here.
      credentials: "omit",
    });
  } finally {
    clearTimeout(t);
  }
}

/**
 * A FastAPI 422: { detail: [{ loc: ["body", "password"], type, msg }, ...] }.
 * Mapped by FIELD and TYPE to the pinned copy, never by echoing `msg`: the copy the
 * user sees is the cleared copy even if the server's text drifts. (Today the
 * server's password messages are word for word the B3 strings; the test pins that
 * against a captured response.) The email is reported first.
 */
export function classify422(body: unknown): SignupError {
  const detail = (body as { detail?: unknown })?.detail;
  if (!Array.isArray(detail)) return "unknown";
  const fields = detail.map((d) => {
    const loc = Array.isArray(d?.loc) ? (d.loc as unknown[]) : [];
    return { field: loc[loc.length - 1], type: d?.type };
  });
  if (fields.some((f) => f.field === "email")) return "invalid_email";
  const pw = fields.find((f) => f.field === "password");
  if (pw?.type === "password_too_long") return "password_long";
  if (pw) return "password_short";
  return "unknown";
}

function classifySignupStatus(status: number, body: unknown): SignupError {
  if (status === 409) return "exists";
  if (status === 429) return "throttled";
  if (status === 422) return classify422(body);
  if (isUnavailable(status)) return "unavailable";
  return "unknown";
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function popupSignup(
  input: { email: string; password: string; terms_version_shown?: string },
  deps: SignupDeps,
): Promise<SignupOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SIGNUP_TIMEOUT_MS;
  const base = deps.baseUrl.replace(/\/+$/, "");

  // 1. Create the account. Not retried: a retry after a timeout that actually
  //    succeeded would read as "email exists" and every attempt counts against the
  //    per-IP limit (SCRUM-393).
  let res: Response;
  try {
    // SCRUM-432: terms_version_shown is set only by a surface that rendered the
    // Terms notice; when undefined, JSON.stringify leaves the key out entirely.
    res = await post(
      doFetch,
      `${base}/api/v1/auth/signup`,
      {
        org_name: SIGNUP_ORG_NAME,
        email: input.email.trim(),
        password: input.password,
        source: SIGNUP_SOURCE,
        terms_version_shown: input.terms_version_shown,
      },
      timeoutMs,
    );
  } catch {
    return { ok: false, error: "unavailable" };
  }
  if (res.status !== 201 && res.status !== 200) {
    return { ok: false, error: classifySignupStatus(res.status, await readJson(res)) };
  }
  const accessToken = (await readJson(res) as { access_token?: unknown } | null)?.access_token;
  if (typeof accessToken !== "string" || !accessToken) return { ok: false, error: "unknown" };

  // 2. Create this install's key with the token. One retry on a network failure
  //    only: the account now exists, so giving up here leaves it without a key
  //    (recoverable on dney.dev, which is what B3 "exists" then says).
  let keyRes: Response | null = null;
  for (let attempt = 0; attempt < 2 && !keyRes; attempt++) {
    try {
      keyRes = await post(doFetch, `${base}/api/v1/auth/api-keys`, { name: EXTENSION_KEY_NAME }, timeoutMs, accessToken);
    } catch {
      keyRes = null;
    }
  }
  if (!keyRes) return { ok: false, error: "unavailable" };
  if (keyRes.status !== 201 && keyRes.status !== 200) {
    return { ok: false, error: isUnavailable(keyRes.status) ? "unavailable" : "unknown" };
  }
  const created = (await readJson(keyRes)) as { key?: unknown; id?: unknown } | null;
  const key = created?.key;
  if (typeof key !== "string" || !key) return { ok: false, error: "unknown" };
  const id = typeof created?.id === "string" && created.id ? created.id : undefined;

  // 3. Store the key. The access token goes out of scope with this frame.
  try {
    await deps.storeKey(key, id);
  } catch {
    return { ok: false, error: "unknown" };
  }
  return { ok: true };
}

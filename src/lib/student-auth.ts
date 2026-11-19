// Student sign-in (SCRUM-292). On a school device whose managed policy carries an
// enrolment_token, the extension does not use an API key. It gets a Google ID
// token for the signed-in school account (chrome.identity.launchWebAuthFlow, a
// fresh nonce) and exchanges it, with the enrolment token, at
// POST {base}/api/v1/students/exchange for a short-lived student credential.
//
// Everything fails CLOSED: no credential means the caller applies the
// fail-safe, which on a managed install is "blocked".
//
// Nothing identifying is kept: the ID token is used once and dropped; only the
// credential and its expiry are stored, in chrome.storage.session (memory only,
// gone when the browser closes).
import type { Config } from "./types";

/**
 * Dney's OAuth client id for the extension's Google sign-in (the ONLY audience
 * the server accepts: GOOGLE_STUDENT_CLIENT_ID). Injected at BUILD time
 * (DNEY_GOOGLE_CLIENT_ID, an esbuild define; see build.mjs), so no build has a
 * client id baked into the source. Unset (every build today, and every test) =
 * "": student mode reports "not set up" and blocks without contacting Google.
 */
declare const DNEY_GOOGLE_CLIENT_ID: string | undefined;
export const GOOGLE_CLIENT_ID: string =
  typeof DNEY_GOOGLE_CLIENT_ID === "string" ? DNEY_GOOGLE_CLIENT_ID : "";

/** Refresh a credential this long before it expires, so a check never races expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const SESSION_KEY = "dney_student_credential";

export type SignInCause = "not_set_up" | "not_enrolled" | "signed_out" | "unavailable";

/** The exchange in flight, shared by concurrent callers: ten sends while the
 *  student is signing in open ONE Google flow, not ten. */
let inflight: Promise<CredentialResult> | null = null;

export type CredentialResult = { ok: true; credential: string } | { ok: false; cause: SignInCause };

interface Stored {
  credential: string;
  expires_at_ms: number;
}

export interface StudentAuthDeps {
  launchWebAuthFlow: (details: { url: string; interactive: boolean }) => Promise<string | undefined>;
  redirectUrl: () => string;
  fetchImpl: typeof fetch;
  storageGet: (key: string) => Promise<Stored | undefined>;
  storageSet: (key: string, value: Stored | null) => Promise<void>;
  now: () => number;
  nonce: () => string;
  clientId: string;
}

export function isStudentMode(config: Config): boolean {
  return !!config.enrolment_token;
}

function defaultDeps(): StudentAuthDeps {
  return {
    launchWebAuthFlow: (details) => chrome.identity.launchWebAuthFlow(details),
    redirectUrl: () => chrome.identity.getRedirectURL(),
    fetchImpl: (...args) => fetch(...args),
    storageGet: async (key) => (await chrome.storage.session.get(key))[key] as Stored | undefined,
    storageSet: async (key, value) => {
      if (value === null) await chrome.storage.session.remove(key);
      else await chrome.storage.session.set({ [key]: value });
    },
    now: () => Date.now(),
    nonce: () => {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    },
    clientId: GOOGLE_CLIENT_ID,
  };
}

/** The `nonce` claim of an ID token, read WITHOUT verifying it: the server
 *  verifies the token; this only checks the reply belongs to OUR request. */
export function idTokenNonce(idToken: string): string | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const nonce = (JSON.parse(json) as { nonce?: unknown }).nonce;
    return typeof nonce === "string" ? nonce : null;
  } catch {
    return null;
  }
}

async function googleIdToken(deps: StudentAuthDeps): Promise<string | null> {
  const nonce = deps.nonce();
  const params = new URLSearchParams({
    client_id: deps.clientId,
    response_type: "id_token",
    scope: "openid email",
    redirect_uri: deps.redirectUrl(),
    nonce,
    prompt: "none", // a managed profile is already signed in; never a login form first
  });
  const url = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  for (const interactive of [false, true]) {
    let redirected: string | undefined;
    try {
      redirected = await deps.launchWebAuthFlow({
        url: interactive ? url.replace("prompt=none", "prompt=select_account") : url,
        interactive,
      });
    } catch {
      continue; // e.g. "interaction required": try once more, interactively
    }
    const token = new URLSearchParams(new URL(redirected ?? "about:blank").hash.slice(1)).get(
      "id_token",
    );
    // A reply without OUR nonce is not an answer to this request.
    if (token && idTokenNonce(token) === nonce) return token;
  }
  return null;
}

/**
 * Exchange a Google ID token for a student credential. Statuses map to causes:
 * 403 not enrolled / not a school account, 401 sign-in not accepted, anything
 * else (429, 5xx, network) unavailable.
 */
async function exchange(config: Config, deps: StudentAuthDeps): Promise<CredentialResult> {
  const idToken = await googleIdToken(deps);
  if (!idToken) return { ok: false, cause: "signed_out" };
  let res: Response;
  try {
    res = await deps.fetchImpl(`${config.dney_base_url}/api/v1/students/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token: idToken, enrolment_token: config.enrolment_token }),
    });
  } catch {
    return { ok: false, cause: "unavailable" };
  }
  if (res.status === 403) return { ok: false, cause: "not_enrolled" };
  if (res.status === 401) return { ok: false, cause: "signed_out" };
  if (!res.ok) return { ok: false, cause: "unavailable" };
  const body = (await res.json()) as { credential?: unknown; expires_in?: unknown };
  if (typeof body.credential !== "string" || typeof body.expires_in !== "number") {
    return { ok: false, cause: "unavailable" };
  }
  await deps.storageSet(SESSION_KEY, {
    credential: body.credential,
    expires_at_ms: deps.now() + body.expires_in * 1000,
  });
  return { ok: true, credential: body.credential };
}

/** A usable credential: the stored one if it is not near expiry, else a new one.
 *  `force` discards the stored one first (the server said 401). */
export async function studentCredential(
  config: Config,
  opts: { force?: boolean; deps?: Partial<StudentAuthDeps> } = {},
): Promise<CredentialResult> {
  const deps = { ...defaultDeps(), ...(opts.deps ?? {}) };
  if (!deps.clientId || !config.enrolment_token) return { ok: false, cause: "not_set_up" };
  if (opts.force) await deps.storageSet(SESSION_KEY, null);
  else {
    const stored = await deps.storageGet(SESSION_KEY);
    if (stored && stored.expires_at_ms - REFRESH_MARGIN_MS > deps.now()) {
      return { ok: true, credential: stored.credential };
    }
  }
  if (!inflight) {
    inflight = exchange(config, deps).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export async function forgetStudentCredential(deps?: Partial<StudentAuthDeps>): Promise<void> {
  await { ...defaultDeps(), ...(deps ?? {}) }.storageSet(SESSION_KEY, null);
}

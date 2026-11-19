// SCRUM-437: sign in from the popup, so an existing user never has to create and
// paste an API key. Runs in the SERVICE WORKER only, like the signup (signup.ts):
// the popup sends email + password over chrome.runtime and gets back an outcome
// id, the org name and which protection line to show; never a token or a key.
//
// Flow (asgard-services main):
//   1. POST /api/v1/auth/login {email, password} -> {access_token} (the JWT).
//   2. GET /api/v1/organizations/me (JWT) -> {name}: the org the key goes to.
//   3. GET /api/v1/guardrails (JWT) -> the org's policies and their modes.
//   4. POST /api/v1/auth/api-keys {name} (JWT) -> {id, key}. 403 = not an admin.
//   5. Store {api_key, api_key_id} in chrome.storage.local.
//   6. Verify: read the key BACK from storage and make one cheap authenticated
//      read with it (GET /api/v1/guardrails, x-api-key). If that fails, the
//      previous state is restored and nothing old is revoked ("key_kept" when a
//      previous key is back in storage and in use; on a first sign-in, "unknown").
//   7. Only then, if this browser held a key from an earlier popup signup or
//      sign-in, DELETE /api/v1/auth/api-keys/{old id} (JWT). Non-fatal.
// The JWT lives only in this function's locals: never stored, never logged, never
// returned, never sent anywhere but those requests to the configured DNey origin.
import { EXTENSION_KEY_NAME } from "./signup";

/** Per request. Login is a bcrypt check; the key mint is one insert. */
export const SIGNIN_TIMEOUT_MS = 20000;

/** What the popup may learn. Each maps to exactly one pinned S-string. */
export type SigninError =
  | "invalid" // 401 (and a 422 malformed email): the neutral S3 line
  | "throttled" // 429
  | "unavailable" // a real network failure: fetch rejected or timed out (login, mint)
  | "key_kept" // the new key failed its check; the PREVIOUS key was restored and is in use
  | "not_admin" // the key mint returned 403 (S5)
  | "confirm_required" // a key is saved and the popup did not confirm S6
  | "unknown"; // anything else: 5xx, a malformed response, a failed first-sign-in verify

/**
 * Which after-sign-in line to show. "unknown" means the guardrail read FAILED:
 * S10 only. "enforce" (S7) is returned ONLY from a successful read with at least
 * one org-wide guardrail in enforce.
 */
export type Protections = "enforce" | "monitor" | "disabled" | "none" | "unknown";

export type SigninOutcome =
  | { ok: true; org_name?: string; protections: Protections; old_key_not_revoked?: true }
  | { ok: false; error: SigninError; org_name?: string };

/** chrome.storage.local, as this flow needs it. */
export interface SigninStore {
  read: () => Promise<{ api_key?: string; api_key_id?: string } | null>;
  write: (items: { api_key: string; api_key_id?: string }) => Promise<void>;
  remove: (keys: string[]) => Promise<void>;
}

export interface SigninDeps {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  store: SigninStore;
  timeoutMs?: number;
}

type Auth = { bearer: string } | { apiKey: string };

async function request(
  doFetch: typeof fetch,
  method: "GET" | "POST" | "DELETE",
  url: string,
  timeoutMs: number,
  auth?: Auth,
  body?: unknown,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && "bearer" in auth) headers.authorization = `Bearer ${auth.bearer}`;
    if (auth && "apiKey" in auth) headers["x-api-key"] = auth.apiKey;
    return await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      // No cookies, no cached credentials: the only credential is the one passed here.
      credentials: "omit",
    });
  } finally {
    clearTimeout(t);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

const ok = (res: Response | null): res is Response => !!res && res.status >= 200 && res.status < 300;

/**
 * The org-wide guardrails (group_id null), counted by mode. An org-wide key is
 * checked against exactly these (config_builder._effective_policies with
 * group_id=None); a grade- or class-scoped copy never applies to it. Anything
 * but a list is a failed read.
 */
export function summarizeGuardrails(body: unknown): Protections {
  if (!Array.isArray(body)) return "unknown";
  const orgWide = body.filter(
    (g) => g && typeof g === "object" && (g as { group_id?: unknown }).group_id == null && !(g as { is_template?: unknown }).is_template,
  ) as { mode?: unknown }[];
  if (orgWide.some((g) => g.mode === "enforce")) return "enforce";
  if (orgWide.some((g) => g.mode === "monitor")) return "monitor";
  return orgWide.length > 0 ? "disabled" : "none";
}

export async function popupSignin(
  input: { email: string; password: string },
  deps: SigninDeps,
): Promise<SigninOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? SIGNIN_TIMEOUT_MS;
  const base = deps.baseUrl.replace(/\/+$/, "");
  const attempt = (
    method: "GET" | "POST" | "DELETE",
    path: string,
    auth?: Auth,
    body?: unknown,
  ): Promise<Response | null> => request(doFetch, method, `${base}${path}`, timeoutMs, auth, body).catch(() => null);

  // 1. Log in. Not retried: every attempt counts against the per-IP and
  //    per-email limit. 401 is the same for an unknown email and a wrong password.
  const loginRes = await attempt("POST", "/api/v1/auth/login", undefined, {
    email: input.email.trim(),
    password: input.password,
  });
  if (!loginRes) return { ok: false, error: "unavailable" };
  if (loginRes.status === 401 || loginRes.status === 422) return { ok: false, error: "invalid" };
  if (loginRes.status === 429) return { ok: false, error: "throttled" };
  if (!ok(loginRes)) return { ok: false, error: "unknown" };
  const jwt = ((await readJson(loginRes)) as { access_token?: unknown } | null)?.access_token;
  if (typeof jwt !== "string" || !jwt) return { ok: false, error: "unknown" };
  const bearer = { bearer: jwt };

  // 2 + 3. The org name and the guardrail list. Neither is fatal: without the
  //    name S11 is left out; without the list the popup shows S10 only.
  const [orgRes, listRes] = await Promise.all([
    attempt("GET", "/api/v1/organizations/me", bearer),
    attempt("GET", "/api/v1/guardrails", bearer),
  ]);
  const rawName = ok(orgRes) ? ((await readJson(orgRes)) as { name?: unknown } | null)?.name : undefined;
  const org_name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : undefined;
  const protections = ok(listRes) ? summarizeGuardrails(await readJson(listRes)) : "unknown";

  // 4. Mint this install's key. Not retried: a retry after a timeout that did
  //    succeed leaves a second key. Nothing has changed in this browser yet.
  const mintRes = await attempt("POST", "/api/v1/auth/api-keys", bearer, { name: EXTENSION_KEY_NAME });
  if (!mintRes) return { ok: false, error: "unavailable" };
  if (mintRes.status === 403) return { ok: false, error: "not_admin", org_name };
  if (!ok(mintRes)) return { ok: false, error: "unknown" };
  const minted = (await readJson(mintRes)) as { id?: unknown; key?: unknown } | null;
  const key = minted?.key;
  const id = minted?.id;
  if (typeof key !== "string" || !key || typeof id !== "string" || !id) return { ok: false, error: "unknown" };

  // 5. Store the new key and its id. The old ones are kept here for a rollback.
  let previous: { api_key?: string; api_key_id?: string } | null;
  try {
    previous = await deps.store.read();
  } catch {
    previous = null;
  }
  const oldKey = typeof previous?.api_key === "string" && previous.api_key ? previous.api_key : undefined;
  const oldId = oldKey && typeof previous?.api_key_id === "string" && previous.api_key_id ? previous.api_key_id : undefined;
  try {
    await deps.store.write({ api_key: key, api_key_id: id });
  } catch {
    await attempt("DELETE", `/api/v1/auth/api-keys/${encodeURIComponent(id)}`, bearer);
    return { ok: false, error: "unknown" };
  }

  // 6. Verify: the key as STORED, accepted by DNey. GET /guardrails takes an API
  //    key (get_org_id), is read-only, sends no text, writes no audit row and costs
  //    no LLM call.
  let verified = false;
  try {
    const stored = (await deps.store.read())?.api_key;
    if (stored === key) {
      const res = await attempt("GET", "/api/v1/guardrails", { apiKey: stored });
      verified = ok(res) && Array.isArray(await readJson(res));
    }
  } catch {
    verified = false;
  }
  if (!verified) {
    // Put back exactly what was there; the old key stays in use, unrevoked.
    let restored = false;
    try {
      if (oldKey) {
        await deps.store.write(oldId ? { api_key: oldKey, api_key_id: oldId } : { api_key: oldKey });
        if (!oldId) await deps.store.remove(["api_key_id"]);
      } else {
        await deps.store.remove(["api_key", "api_key_id"]);
      }
      // Restored means READ BACK: the saved key is the previous one (or none).
      const now = await deps.store.read();
      restored = (now?.api_key || undefined) === oldKey && (now?.api_key_id || undefined) === oldId;
    } catch {
      restored = false;
    }
    // The unverified key is no longer saved anywhere: tidy it away (best effort).
    // If the restore failed it is still the saved key, so it is left alone.
    if (restored) await attempt("DELETE", `/api/v1/auth/api-keys/${encodeURIComponent(id)}`, bearer);
    // G3b ("still using your previous key") ONLY when a previous key really is
    // saved again. A first sign-in, or a restore that did not stick: G3a.
    return { ok: false, error: restored && oldKey ? "key_kept" : "unknown" };
  }

  // 7. Only now retire the key this browser used before. A failure is not fatal:
  //    the old key stays listed in the dashboard and can be revoked there.
  //    old_key_not_revoked (S12) is set ONLY when an id'd old key's delete failed.
  if (oldId && oldId !== id) {
    const revoked = await attempt("DELETE", `/api/v1/auth/api-keys/${encodeURIComponent(oldId)}`, bearer);
    if (!ok(revoked)) return { ok: true, org_name, protections, old_key_not_revoked: true };
  }
  return { ok: true, org_name, protections };
}

// Config. Consumer install: sync (user settings) > defaults, and the API key from
// chrome.storage.LOCAL only (never sync, which is copied to the user's Google
// account; SCRUM-395, Assay). Managed (school/enterprise)
// install: policy > managed-install defaults (closed); sync ignored. SCRUM-303.
import type { Config } from "./types";

/**
 * Total wall-clock a single check may spend WAITING OUT 429s, on top of its
 * per-attempt timeout. Bounds the send path: however long the server asks us to
 * back off, the composer is never held longer than input_timeout_ms + this.
 */
export const RETRY_BUDGET_MS = 10000;

/**
 * How long the content script waits on the service worker before it gives up and
 * declares the message UNCHECKED. It must exceed what the client itself can
 * legitimately spend, or the bridge times out first and the send silently fails
 * open while a perfectly good check is still in flight — which is what a fixed
 * 12s did once input_timeout_ms was raised to 30s.
 */
export function bridgeDeadlineMs(config: Pick<Config, "input_timeout_ms">): number {
  return config.input_timeout_ms + RETRY_BUDGET_MS + 2000;
}

/** The bounds the options UI will persist an input timeout within (see NUMERIC_BOUNDS).
 *  Declared here, above the deadline maths, because the deadline that has to cover
 *  every legal config is derived from the ceiling rather than restated next to it. */
export const MIN_INPUT_TIMEOUT_MS = 1000;
export const MAX_INPUT_TIMEOUT_MS = 120000;

/**
 * The deadline that covers EVERY config a user is allowed to save. The MAIN-world
 * fetch hook cannot read storage, so it cannot compute the effective deadline for
 * itself; until the ISOLATED relay tells it (see the "deadline" bridge message) it
 * must wait this long rather than a shorter default, or a user who raised
 * input_timeout_ms gets exactly the fail-open the deadline exists to prevent.
 * Waiting too long is recoverable — the relay answers first in practice; waiting
 * too short sends unchecked text.
 */
export const MAX_BRIDGE_DEADLINE_MS = bridgeDeadlineMs({ input_timeout_ms: MAX_INPUT_TIMEOUT_MS });

/**
 * Validate a deadline that arrived over the page bridge. The MAIN world must not
 * take a postMessage from the page at face value: any script on the page can post
 * to `window`, and a hostile "deadline: 1" would disarm the safety net while a
 * "deadline: Infinity" would hang every send. Anything outside the range the
 * config bounds can produce is rejected, and the caller keeps its ceiling.
 */
export function clampBridgeDeadlineMs(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const min = bridgeDeadlineMs({ input_timeout_ms: MIN_INPUT_TIMEOUT_MS });
  if (raw < min || raw > MAX_BRIDGE_DEADLINE_MS) return null;
  return Math.round(raw);
}

export const DEFAULT_CONFIG: Config = {
  dney_base_url: "https://api.dney.dev",
  api_key: "",
  input_mode: "enforce",
  output_mode: "enforce_soft",
  fail_policy: "open",
  allow_override: false,
  chunk_size: 800,
  chunk_interval_ms: 2500,
  // Measured against a fully-enforcing org (2026-08-10): a CLEAN input runs every
  // semantic self-check sequentially — p50 17.1s, mean 18.8s, max 33.6s. At the
  // previous 8000ms every clean message timed out and, under fail_policy "open",
  // was sent unchecked; semantic-only catches were lost the same way, leaving just
  // the sub-second signature layer enforcing. 30s covers p90 of that distribution.
  // Revisit downward (~12s) once backend self-checks run concurrently.
  input_timeout_ms: 30000,
  output_timeout_ms: 4000,
  audit_buffer_size: 500,
  enrolment_token: "",
};

/** Bounds for numeric fields: below the floor a check cannot complete, above the
 * ceiling the composer would appear hung. Out-of-range or unparseable input
 * falls back to the default rather than persisting a value that silently
 * disables checking (0 would make every check time out instantly). */
const NUMERIC_BOUNDS: Partial<Record<keyof Config, { min: number; max: number }>> = {
  input_timeout_ms: { min: MIN_INPUT_TIMEOUT_MS, max: MAX_INPUT_TIMEOUT_MS },
  output_timeout_ms: { min: MIN_INPUT_TIMEOUT_MS, max: MAX_INPUT_TIMEOUT_MS },
};

export function coerceNumericField(key: keyof Config, raw: string): number {
  const fallback = DEFAULT_CONFIG[key] as number;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  const bounds = NUMERIC_BOUNDS[key];
  if (bounds && (parsed < bounds.min || parsed > bounds.max)) return fallback;
  return Math.round(parsed);
}

/**
 * The managed read FAILED (chrome.storage.managed.get rejected). Measured 27 Sep
 * (SCRUM-303, Chromium 145): with NO policy the read RESOLVES {}; it does not
 * reject. So a rejection is a genuine failure, and on a school device the only
 * safe reading of "we could not read the policy" is "this is managed".
 */
export const MANAGED_READ_FAILED = Symbol("managed-read-failed");

/**
 * Whether ANY site adapter checks the AI's replies. None does yet: the output rail
 * (buffer-and-release on the reply stream) is Phase D. Until then output_mode has
 * no effect, and the UI must say "AI replies: not checked yet" rather than show an
 * output mode as if it were enforced (SCRUM-303). test/output-rail-honesty pins
 * this against every adapter's sse.outputSupported.
 */
export const OUTPUT_RAIL_AVAILABLE = false;
export const OUTPUT_NOT_CHECKED = "AI replies: not checked yet";
export type ManagedArea = Partial<Config> | null | undefined | typeof MANAGED_READ_FAILED;

/**
 * chrome.storage.local: the API key (from the popup signup or a key pasted in
 * Settings) and whether the welcome tab has been opened. The key is NEVER kept in
 * chrome.storage.sync, which Chrome copies to the user's Google account.
 */
export interface LocalArea {
  api_key?: string;
  /**
   * SCRUM-437: the server id of api_key, when the popup (signup or sign-in)
   * minted it. Lets a later popup sign-in revoke the key it replaces. Cleared
   * whenever Settings changes the key, so it never names a key not in use here.
   */
  api_key_id?: string;
  welcome_opened?: boolean;
}

export async function readLocal(): Promise<LocalArea | null> {
  try {
    return (await chrome.storage.local.get(["api_key", "api_key_id", "welcome_opened"])) as LocalArea;
  } catch {
    return null;
  }
}

/**
 * Defaults for a MANAGED (school/enterprise) install, where the policy is silent.
 * A consumer install keeps DEFAULT_CONFIG (fail-open, enforce_soft): unchanged.
 * A school that wants fail-open must say so in its policy (s303-02).
 */
export const MANAGED_INSTALL_DEFAULTS: Pick<
  Config,
  "fail_policy" | "input_mode" | "output_mode" | "allow_override"
> = {
  fail_policy: "closed",
  input_mode: "enforce",
  output_mode: "enforce_hard",
  allow_override: false,
};

/** Managed = the policy set at least one key, OR the policy could not be read. */
export function isManagedInstall(managed: ManagedArea): boolean {
  if (managed === MANAGED_READ_FAILED) return true;
  return !!managed && Object.keys(managed).length > 0;
}

const ENUMS: Partial<Record<keyof Config, readonly unknown[]>> = {
  input_mode: ["enforce", "monitor", "off"],
  output_mode: ["enforce_hard", "enforce_soft", "monitor", "off"],
  fail_policy: ["open", "closed"],
  allow_override: [true, false],
};

/** Only known keys with values of the right shape; anything else falls back to the
 *  managed-install default rather than to something the policy did not say. */
function validPolicy(policy: Partial<Config>): Partial<Config> {
  const out: Partial<Config> = {};
  for (const [k, v] of Object.entries(policy) as [keyof Config, unknown][]) {
    if (!(k in DEFAULT_CONFIG)) continue;
    const allowed = ENUMS[k];
    if (allowed ? !allowed.includes(v) : typeof v !== typeof DEFAULT_CONFIG[k]) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * The effective config.
 *
 * CONSUMER install (no managed policy): defaults < sync, exactly as before.
 *
 * MANAGED install: managed-install defaults < the policy. SYNC IS IGNORED
 * ENTIRELY. Sync is what the options page (or chrome.storage.sync from devtools)
 * writes, so on a school device it is student-editable; honouring any of it let a
 * student switch guarding off or to fail-open (SCRUM-303 F1b). No field is
 * user-editable on a managed install: even the timeouts matter, because under a
 * school's explicit fail-open a student shortening them would turn every check
 * into a timeout, i.e. into unguarded traffic.
 */
export function mergeConfig(
  managed: ManagedArea,
  sync: Partial<Config> | null | undefined,
  local?: LocalArea | null,
): Config {
  if (!isManagedInstall(managed)) {
    // The key is read from LOCAL only. A key still in sync (0.2.0 and earlier) is
    // ignored here; migrateSyncKey() moves it to local before any read.
    const { api_key: _ignoredSyncKey, ...settings } = sync ?? {};
    void _ignoredSyncKey;
    const key = typeof local?.api_key === "string" ? local.api_key : "";
    return { ...DEFAULT_CONFIG, ...settings, api_key: key };
  }
  // Managed: local is ignored exactly as sync is; the key comes from the policy.
  const policy = managed === MANAGED_READ_FAILED ? {} : validPolicy(managed as Partial<Config>);
  return { ...DEFAULT_CONFIG, ...MANAGED_INSTALL_DEFAULTS, ...policy };
}

/** Fields the options UI must show read-only: every field on a managed install. */
export function lockedKeys(managed: ManagedArea): (keyof Config)[] {
  return isManagedInstall(managed) ? (Object.keys(DEFAULT_CONFIG) as (keyof Config)[]) : [];
}

export async function readManaged(): Promise<ManagedArea> {
  try {
    return (await chrome.storage.managed.get(null)) as Partial<Config>;
  } catch {
    return MANAGED_READ_FAILED;
  }
}

async function readSync(): Promise<Partial<Config> | null> {
  try {
    return (await chrome.storage.sync.get(null)) as Partial<Config>;
  } catch {
    return null;
  }
}

export interface ConfigState {
  config: Config;
  managed: boolean;
  /** The policy could not be read: the closed defaults are in force (s303-05). */
  managedReadFailed: boolean;
}

/**
 * One-time, idempotent move of a key kept in chrome.storage.sync (0.2.0 and
 * earlier wrote the Settings paste there) into chrome.storage.local, then delete
 * it from sync. Local is written FIRST, so a failure between the two steps leaves
 * the key in both and the next run finishes the job; the key is never lost. The
 * synced key wins over a local one because it was the key in use. Managed-policy
 * keys are not in sync and are untouched.
 */
export async function migrateSyncKey(): Promise<"moved" | "cleared" | "none" | "failed"> {
  try {
    const { api_key: synced } = (await chrome.storage.sync.get("api_key")) as { api_key?: unknown };
    if (synced === undefined) return "none";
    if (typeof synced === "string" && synced) await chrome.storage.local.set({ api_key: synced });
    await chrome.storage.sync.remove("api_key");
    return typeof synced === "string" && synced ? "moved" : "cleared";
  } catch {
    return "failed";
  }
}

export async function loadConfigState(): Promise<ConfigState> {
  // Every reader migrates first, so an upgraded user's key is never read as
  // missing (which would show them the signup form).
  await migrateSyncKey();
  const [managed, sync, local] = await Promise.all([readManaged(), readSync(), readLocal()]);
  return {
    config: mergeConfig(managed, sync, local),
    managed: isManagedInstall(managed),
    managedReadFailed: managed === MANAGED_READ_FAILED,
  };
}

export async function loadConfig(): Promise<Config> {
  return (await loadConfigState()).config;
}

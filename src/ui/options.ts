// Options page: shows effective config; saves the API key to local storage and the
// other user overrides to sync storage (settings-store.ts).
// On a MANAGED (school/enterprise) install every field is set by the organisation
// and shown read-only, and nothing is saved (SCRUM-303): sync is ignored there.
import {
  DEFAULT_CONFIG,
  coerceNumericField,
  isManagedInstall,
  lockedKeys,
  MANAGED_READ_FAILED,
  OUTPUT_NOT_CHECKED,
  OUTPUT_RAIL_AVAILABLE,
  mergeConfig,
  migrateSyncKey,
  readLocal,
  readManaged,
} from "../lib/config";
import { WELCOME_PATH } from "../lib/onboarding";
import { saveSettings } from "../lib/settings-store";
import { COPY } from "./onboarding-copy";
import type { Config } from "../lib/types";

interface Field {
  key: keyof Config;
  label: string;
  type: "text" | "select" | "checkbox" | "number";
  options?: string[];
}

const FIELDS: Field[] = [
  { key: "dney_base_url", label: "DNey API base URL", type: "text" },
  { key: "api_key", label: "API key", type: "text" },
  { key: "input_mode", label: "Input mode", type: "select", options: ["enforce", "monitor", "off"] },
  { key: "output_mode", label: "Output mode", type: "select", options: ["enforce_hard", "enforce_soft", "monitor", "off"] },
  { key: "fail_policy", label: "On failure", type: "select", options: ["open", "closed"] },
  { key: "allow_override", label: "Allow user override of modified messages", type: "checkbox" },
  { key: "input_timeout_ms", label: "Input check timeout (ms)", type: "number" },
  { key: "output_timeout_ms", label: "Output check timeout (ms)", type: "number" },
];

/** Secrets are never displayed on a managed install; the student has no use for them. */
const HIDDEN_WHEN_MANAGED: (keyof Config)[] = ["api_key"];

async function render() {
  await migrateSyncKey(); // a 0.2.0 key in sync moves to local before it is shown
  const managed = await readManaged();
  const sync = (await chrome.storage.sync.get(null).catch(() => ({}))) as Partial<Config>;
  const local = await readLocal();
  const cfg = mergeConfig(managed, sync, local);
  const locked = new Set(lockedKeys(managed));
  const isManaged = isManagedInstall(managed);
  const form = document.getElementById("form")!;
  form.innerHTML = "";
  const banner = document.getElementById("managed")!;
  banner.textContent = !isManaged
    ? ""
    : managed === MANAGED_READ_FAILED
      ? "Your organisation's settings could not be read, so DNey Guard is using its safest settings."
      : "These settings are managed by your organisation.";
  (document.getElementById("save") as HTMLButtonElement).hidden = isManaged;
  // SCRUM-396: the welcome tab stays reachable from Settings (consumer installs).
  const welcome = document.getElementById("welcome") as HTMLAnchorElement;
  welcome.hidden = isManaged;
  welcome.textContent = COPY["C.tab_title"];
  welcome.href = chrome.runtime.getURL(WELCOME_PATH);

  for (const f of FIELDS) {
    if (f.key === "output_mode" && !OUTPUT_RAIL_AVAILABLE) {
      // No adapter checks replies yet: show that, not a control that does nothing.
      const note = document.createElement("p");
      note.className = "locked-note";
      note.textContent = `${OUTPUT_NOT_CHECKED}.`;
      form.appendChild(note);
      continue;
    }
    const wrap = document.createElement("div");
    if (locked.has(f.key)) wrap.className = "locked";
    const label = document.createElement("label");
    label.textContent = f.label;
    wrap.appendChild(label);

    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === "select") {
      input = document.createElement("select");
      for (const opt of f.options!) {
        const o = document.createElement("option");
        o.value = o.textContent = opt;
        input.appendChild(o);
      }
      input.value = String(cfg[f.key]);
    } else if (f.type === "checkbox") {
      input = document.createElement("input");
      input.type = "checkbox";
      (input as HTMLInputElement).checked = Boolean(cfg[f.key]);
    } else {
      input = document.createElement("input");
      input.type = f.type === "number" ? "number" : "text";
      input.value =
        isManaged && HIDDEN_WHEN_MANAGED.includes(f.key)
          ? cfg[f.key]
            ? "(set by your organisation)"
            : "(not set)"
          : String(cfg[f.key]);
    }
    input.id = `f_${f.key}`;
    if (locked.has(f.key)) input.setAttribute("disabled", "true");
    wrap.appendChild(input);
    if (locked.has(f.key)) {
      const note = document.createElement("div");
      note.className = "locked-note";
      note.textContent = "Set by your organization";
      wrap.appendChild(note);
    }
    form.appendChild(wrap);
  }
}

async function save() {
  const managed = await readManaged();
  if (isManagedInstall(managed)) return; // nothing a student saves is ever read
  const locked = new Set(lockedKeys(managed));
  const out: Partial<Config> = {};
  for (const f of FIELDS) {
    if (locked.has(f.key)) continue;
    if (f.key === "output_mode" && !OUTPUT_RAIL_AVAILABLE) continue; // not rendered
    const el = document.getElementById(`f_${f.key}`) as HTMLInputElement | HTMLSelectElement;
    if (f.type === "checkbox") (out as any)[f.key] = (el as HTMLInputElement).checked;
    else if (f.type === "number") (out as any)[f.key] = coerceNumericField(f.key, el.value);
    else (out as any)[f.key] = el.value || (DEFAULT_CONFIG as any)[f.key];
  }
  // SCRUM-395: the key goes to chrome.storage.local only (an empty field clears it
  // from local and sync); the other settings stay in sync. See settings-store.ts.
  await saveSettings(out);
  const status = document.getElementById("status")!;
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 1500);
}

document.getElementById("save")!.addEventListener("click", save);
void render();

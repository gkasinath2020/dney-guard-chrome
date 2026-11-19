/**
 * PRIVACY GUARD — the extension must never gain a second destination.
 *
 * WHAT THIS PROTECTS
 * DNey's core promise is that raw prompts and responses are never stored: the
 * server keeps enriched metadata — types and counts — and nothing else. That half
 * is enforced and tested server-side. This half is not enforced by anything at
 * runtime, because a browser extension can talk to whatever its permissions allow.
 *
 * The realistic way the promise breaks is not malice. It is someone adding Sentry
 * for crash reports, an analytics ping to count active users, or a debug log that
 * prints the prompt while chasing a bug — in a client whose entire job is handling
 * text people consider sensitive. Any of those turns "your prompt goes to your own
 * DNey and nowhere else" into a false statement, and no reviewer reliably catches
 * it in a diff.
 *
 * So these tests fail the build when a new outbound destination appears, when the
 * manifest's reach widens, or when prompt text reaches a logging path.
 *
 * IF YOU ARE READING THIS BECAUSE A TEST FAILED
 * The test is not asking you to be careful. It is telling you that the change in
 * front of you would let user prompt text leave for somewhere it has never gone,
 * or widen the extension's reach beyond claude.ai and the DNey API. That is a
 * product decision about a privacy promise made to users and to enterprise
 * buyers — not a test to relax. If the destination is genuinely intended, the
 * allowlists below are the one place to change, and changing them should be the
 * visible, argued part of the merge request.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import esbuild from "esbuild";
import { check } from "../src/lib/dney-client";
import { DEFAULT_CONFIG } from "../src/lib/config";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * The ONLY hosts any client code may name. `api.dney.dev` is the default DNey
 * endpoint (the user may point it at their own DNey; that is the same
 * destination, differently addressed). `claude.ai` and `chatgpt.com` are the
 * pages the extension runs inside — their own traffic, which the fetch hook
 * observes and passes through untouched.
 */
const ALLOWED_HOSTS = new Set(["api.dney.dev", "claude.ai", "chatgpt.com"]);

/**
 * SCRUM-292 (student sign-in), argued here as this file asks: a school device
 * proves which student it is by getting a Google ID token for the signed-in school
 * account. That is chrome.identity.launchWebAuthFlow to Google's authorization
 * endpoint, from the SERVICE WORKER ONLY. No prompt or response text is ever part
 * of it: the request carries our OAuth client id, a nonce and a redirect URL, and
 * the reply is an ID token that goes to DNey's /students/exchange and is dropped.
 * It is allowed in the background bundle and nowhere else.
 */
const BACKGROUND_ONLY_HOSTS = new Set(["accounts.google.com"]);

/**
 * SCRUM-395/396 (0.3.0), argued here as this file asks: the popup signup and the
 * welcome tab show LINKS to dney.dev (the privacy policy, sign-in, the dashboard),
 * exactly as the copy cleared by Assay names them. A link is a navigation the user
 * clicks, opened in a new tab; the extension sends nothing to dney.dev and no text
 * goes with it. The bundles that may name it are the three extension PAGES, never
 * the service worker or a content script (which run beside the prompt).
 */
const PAGE_LINK_HOSTS = new Set(["dney.dev"]);
const PAGE_ENTRIES = new Set(["ui/options", "ui/popup", "ui/welcome"]);

/** Names of the telemetry/error-reporting services this extension must not gain. */
const TELEMETRY_NAMES = [
  "sentry",
  "bugsnag",
  "rollbar",
  "datadog",
  "newrelic",
  "logrocket",
  "posthog",
  "mixpanel",
  "amplitude",
  "segment.io",
  "segment.com",
  "google-analytics",
  "googletagmanager",
  "hotjar",
  "fullstory",
  "intercom",
  "heap.io",
  "statsig",
  "launchdarkly",
];

function srcFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...srcFiles(rel));
    else if (name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

describe("the built bundles can name no host but DNey and the pages we run in", () => {
  // The source is what people review; the BUNDLE is what ships. Scanning the
  // build output also catches a destination that arrives inside a dependency.
  const built = esbuild.buildSync({
    entryPoints: {
      background: "src/background.ts",
      "content/main": "src/content/main.ts",
      "content/page-hook": "src/content/page-hook.ts",
      "ui/options": "src/ui/options.ts",
      "ui/popup": "src/ui/popup.ts",
      "ui/welcome": "src/ui/welcome.ts",
    },
    absWorkingDir: root,
    outdir: "dist-privacy-scan",
    bundle: true,
    format: "iife",
    target: "chrome120",
    write: false,
    logLevel: "silent",
  });

  const bundles = built.outputFiles.map((f) => ({ path: f.path, text: f.text }));

  it("bundles every entry point (a scan that silently covers nothing proves nothing)", () => {
    expect(bundles.length).toBe(6);
  });

  it.each(["background", "content/main", "content/page-hook", "ui/options", "ui/popup", "ui/welcome"])(
    "%s reaches only allowlisted hosts",
    (entry) => {
      const bundle = bundles.find((b) => b.path.includes(entry.replace("/", "/")));
      expect(bundle, `no bundle built for ${entry}`).toBeDefined();
      const hosts = new Set<string>();
      for (const m of bundle!.text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        hosts.add(m[1].toLowerCase());
      }
      for (const host of hosts) {
        expect(
          ALLOWED_HOSTS.has(host) ||
            (entry === "background" && BACKGROUND_ONLY_HOSTS.has(host)) ||
            (PAGE_ENTRIES.has(entry) && PAGE_LINK_HOSTS.has(host)),
          `${entry} can reach ${host}, which is not DNey and not the page we run in. ` +
            `A second destination in a client that handles prompts breaks the ` +
            `metadata-only promise. Add it to ALLOWED_HOSTS only if shipping it is ` +
            `the point of your change.`,
        ).toBe(true);
      }
    },
  );

  it("names no telemetry or error-reporting service anywhere in the shipped code", () => {
    for (const { path, text } of bundles) {
      const lower = text.toLowerCase();
      for (const name of TELEMETRY_NAMES) {
        expect(
          lower.includes(name),
          `${path} mentions "${name}". Crash and analytics SDKs capture surrounding ` +
            `state — which here is the user's prompt — and ship it to a third party.`,
        ).toBe(false);
      }
    }
  });

  it("opens no transport other than the one fetch in the DNey client", () => {
    // sendBeacon and an <img> ping both survive page unload and are the classic
    // way an analytics call gets added without looking like a network call.
    const forbidden = [
      "XMLHttpRequest",
      "sendBeacon",
      "new WebSocket",
      "EventSource",
      "importScripts",
      "navigator.connection",
    ];
    for (const { path, text } of bundles) {
      for (const bad of forbidden) {
        expect(text.includes(bad), `${path} uses ${bad} — a transport no client code needs`).toBe(
          false,
        );
      }
    }
  });
});

describe("only the DNey client may originate a request", () => {
  const files = srcFiles();

  it("scans the whole source tree (not an empty list)", () => {
    expect(files.length).toBeGreaterThan(8);
    expect(files).toContain("src/lib/dney-client.ts");
  });

  it("no file but src/lib/dney-client.ts builds a request URL", () => {
    // Everything that leaves this extension leaves from one function, so there is
    // exactly one place to audit. src/lib/config.ts holds the default base URL as
    // configuration; it makes no call.
    // src/lib/student-auth.ts (SCRUM-292) is the second audited exit: it sends ONLY
    // {id_token, enrolment_token} to DNey and a sign-in request to Google, never
    // text; pinned below.
    // src/ui/onboarding-copy.ts (SCRUM-395/396) holds the three dney.dev LINKS the
    // cleared copy names (privacy, sign-in, dashboard); it makes no call. The popup
    // signup's requests (src/lib/signup.ts) go to the configured DNey base URL and
    // name no absolute URL; their bodies are pinned below.
    const urlOwners = ["src/lib/dney-client.ts", "src/lib/config.ts", "src/lib/student-auth.ts", "src/ui/onboarding-copy.ts"];
    for (const rel of files) {
      if (urlOwners.includes(rel)) continue;
      const matches = [...read(rel).matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]);
      expect(
        matches,
        `${rel} names an absolute URL. Outbound calls belong in src/lib/dney-client.ts, ` +
          `which is the single audited exit point for prompt text.`,
      ).toEqual([]);
    }
  });

  it("names no telemetry service and opens no second transport, in the SOURCE too", () => {
    // The bundle scan can miss what a bundler tree-shakes away today and keeps
    // tomorrow, and it is the source that a reviewer reads. Both are checked, so
    // neither is the only thing standing between a prompt and a third party.
    const forbidden = [
      ...TELEMETRY_NAMES,
      "xmlhttprequest",
      "sendbeacon",
      "new websocket",
      "eventsource",
      "importscripts",
    ];
    for (const rel of files) {
      const lower = read(rel).toLowerCase();
      for (const bad of forbidden) {
        expect(
          lower.includes(bad),
          `${rel} mentions "${bad}" — a reporting service or a transport that would ` +
            `carry prompt text somewhere other than the user's own DNey`,
        ).toBe(false);
      }
    }
  });

  it("the student sign-in never carries prompt or response text", () => {
    const src = read("src/lib/student-auth.ts");
    // exactly one request body, and it names exactly these two fields
    const bodies = [...src.matchAll(/body:\s*JSON\.stringify\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    expect(bodies).toHaveLength(1);
    expect(
      bodies[0]
        .split(",")
        .map((p) => p.split(":")[0].trim())
        .sort(),
    ).toEqual(["enrolment_token", "id_token"]);
    // it takes no text: no exported function has a text/prompt parameter
    expect(src).not.toMatch(/export (async )?function \w+\([^)]*\b(text|prompt|body)\b/);
    // Google is reached only through launchWebAuthFlow, never fetch
    expect(src).not.toMatch(/fetch[A-Za-z]*\([^)]*accounts\.google\.com/);
  });

  it("the popup signup (SCRUM-395) sends only account fields to DNey, never prompt text, and is the only other fetch", () => {
    const src = read("src/lib/signup.ts");
    // exactly two requests, both to the configured DNey base, with these fields only
    const calls = [...src.matchAll(/post\(\s*doFetch,\s*`\$\{base\}([^`]+)`,\s*\{([^}]*)\}/g)].map((m) => ({
      path: m[1],
      fields: m[2].split(",").map((p) => p.split(":")[0].trim()).filter(Boolean).sort(),
    }));
    expect(calls).toEqual([
      { path: "/api/v1/auth/signup", fields: ["email", "org_name", "password", "source", "terms_version_shown"] },
      { path: "/api/v1/auth/api-keys", fields: ["name"] },
    ]);
    expect(src.match(/doFetch\(/g)?.length).toBe(1); // the one fetch, inside post()
    expect(src).not.toMatch(/export (async )?function \w+\([^)]*\b(text|prompt)\b/);
    // Try-it (SCRUM-396) goes through the DNey client's check(), not a fetch of its own.
    const onboarding = read("src/lib/onboarding.ts");
    expect(onboarding).not.toMatch(/\bfetch\(/);
    expect(onboarding).toMatch(/await check\(\{/);
  });

  it("the popup sign-in (SCRUM-437) sends only account fields to DNey, never prompt text", () => {
    const src = read("src/lib/signin.ts");
    // every request, in source order: method and path (a DELETE's id is a uuid
    // from the server). Only login and the key mint carry a body; pinned below.
    const calls = [...src.matchAll(/attempt\(\s*"(GET|POST|DELETE)",\s*["`]([^"`$]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(calls).toEqual([
      "POST /api/v1/auth/login",
      "GET /api/v1/organizations/me",
      "GET /api/v1/guardrails",
      "POST /api/v1/auth/api-keys",
      "DELETE /api/v1/auth/api-keys/",
      "GET /api/v1/guardrails",
      "DELETE /api/v1/auth/api-keys/",
      "DELETE /api/v1/auth/api-keys/",
    ]);
    const bodies = [...src.matchAll(/attempt\("POST", "([^"]+)", [a-z]+, \{([^}]*)\}\)/g)].map((m) => ({
      path: m[1],
      fields: m[2].split(",").map((p) => p.split(":")[0].trim()).filter(Boolean),
    }));
    expect(bodies).toEqual([
      { path: "/api/v1/auth/login", fields: ["email", "password"] },
      { path: "/api/v1/auth/api-keys", fields: ["name"] },
    ]);
    expect(src.match(/doFetch\(/g)?.length).toBe(1); // the one fetch, inside request()
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/export (async )?function \w+\([^)]*\b(text|prompt)\b/);
  });

  it("the fetch hook passes the page's own requests through untouched", () => {
    // The MAIN-world hook replaces window.fetch. If it ever rewrote the URL or
    // duplicated the request, claude.ai's traffic would gain a destination without
    // any new fetch call appearing anywhere.
    const hook = read("src/content/page-hook.ts");
    expect(hook).toContain("const orig = window.fetch");
    const calls = [...hook.matchAll(/orig\.call\(\s*this\s*,\s*([^,]+),/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThan(0);
    for (const arg of calls) {
      expect(
        arg.startsWith("input"),
        `the hook calls the original fetch with ${arg} instead of the caller's own ` +
          `input — it must never redirect or copy the page's traffic`,
      ).toBe(true);
    }
  });

  it("ships no third-party runtime dependency that could add one", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(
      Object.keys(pkg.dependencies ?? {}),
      "the extension bundles its own source only; a runtime dependency is code that " +
        "ships to users without appearing in this repo's diffs",
    ).toEqual([]);
    const devDeps = Object.keys(pkg.devDependencies ?? {}).join(" ").toLowerCase();
    for (const name of TELEMETRY_NAMES) {
      expect(devDeps.includes(name), `${name} was added as a dependency`).toBe(false);
    }
  });
});

describe("the manifest's reach stays minimal", () => {
  const manifest = JSON.parse(read("manifest.json"));

  it("grants host access to the guarded sites and the DNey API and nothing else", () => {
    // chatgpt.com: the ChatGPT adapter existed but the manifest never injected on
    // its site, so ChatGPT prompts were unguarded (Assay, measured in Chromium).
    // A guarded site, not a destination: the page's own traffic, observed.
    // host_permissions is the hard ceiling on where this extension can send
    // anything at all. Widening it is how a second destination becomes possible in
    // the first place, and it is the line a Chrome Web Store reviewer reads too.
    expect(
      [...manifest.host_permissions].sort(),
      "host permissions changed — every entry here is a place user prompts could go",
    ).toEqual(["https://api.dney.dev/*", "https://chatgpt.com/*", "https://claude.ai/*"]);
  });

  it("never asks for a wildcard host", () => {
    const wildcards = ["<all_urls>", "*://*/*", "http://*/*", "https://*/*"];
    const surfaces = [
      ...(manifest.host_permissions ?? []),
      ...(manifest.optional_host_permissions ?? []),
      ...(manifest.permissions ?? []),
      ...(manifest.optional_permissions ?? []),
      ...(manifest.content_scripts ?? []).flatMap((cs: { matches?: string[] }) => cs.matches ?? []),
    ];
    for (const entry of surfaces) {
      expect(wildcards.includes(entry), `${entry} would let this run on every site`).toBe(false);
    }
  });

  it("asks for storage and no other capability", () => {
    // Not webRequest, not cookies, not clipboard — permissions that would let the
    // extension read or forward far more than the prompt it is checking.
    // `identity` (SCRUM-292, launchWebAuthFlow for the student's Google sign-in)
    // is NOT declared while no Google client ID is built in: the store rejects a
    // declared-but-unusable permission, and without a client ID the student path
    // stops at "not_set_up" before touching chrome.identity (student-auth test).
    // Add it back in the release that sets DNEY_GOOGLE_CLIENT_ID.
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.optional_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
  });

  it("lets no outside page talk to the extension", () => {
    // externally_connectable would open a channel from web pages into the service
    // worker, which holds the API key and every prompt in flight.
    expect(manifest.externally_connectable ?? null).toBeNull();
  });

  it("runs content scripts only on the sites it guards", () => {
    for (const cs of manifest.content_scripts ?? []) {
      for (const match of cs.matches ?? []) {
        const host = new URL(match.replace("*://", "https://")).hostname.replace(/^\*\./, "");
        expect(
          ALLOWED_HOSTS.has(host),
          `a content script runs on ${host}, a site this extension has no business reading`,
        ).toBe(true);
      }
    }
  });
});

describe("prompt text never reaches a log", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Every console call in the source, with its arguments. */
  function consoleCalls(text: string): string[] {
    return [...text.matchAll(/console\.(?:log|info|debug|warn|error|trace)\(([^;]*?)\)\s*;/gs)].map(
      (m) => m[1],
    );
  }

  it("no console call in the source passes the prompt or response body", () => {
    // Lengths and counts are fine — that is the metadata the product is built on.
    // The text itself is not, in any client, at any log level. A debug line added
    // while chasing a bug is the single most likely way this promise breaks, and
    // it survives into shipped builds because nothing strips console in a bundle.
    const suspicious = /(^|[^.\w])(text|prompt|body|original_text|composerText\(\)|d\.text|data\.text|msg\.text)\b(?!\s*\.\s*(length|slice))/;
    for (const rel of srcFiles()) {
      for (const args of consoleCalls(read(rel))) {
        expect(
          suspicious.test(args),
          `${rel} logs prompt or response text: console(${args.trim()}). Log a length or a ` +
            `count instead — the text belongs only in the request to DNey.`,
        ).toBe(false);
      }
    }
  });

  it("a failing check logs the failure without echoing what was being checked", async () => {
    // The static rule above cannot see through a variable that was renamed, so the
    // failure paths are also exercised for real with a canary prompt.
    const canary = "PROMPT-CANARY-4f81-never-log-me";
    const spies = (["log", "info", "debug", "warn", "error", "trace"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const responses: Array<() => Response> = [
      () => new Response("", { status: 429, headers: { "Retry-After": "1" } }),
      () => new Response("nope", { status: 500 }),
      () => new Response("nope", { status: 403 }),
    ];
    for (const make of responses) {
      await check({
        config: { ...DEFAULT_CONFIG, api_key: "asg_test" },
        direction: "input",
        text: canary,
        metadata: { surface: "claude-web" },
        fetchImpl: (async () => make()) as unknown as typeof fetch,
        sleepImpl: async () => undefined,
      });
    }
    await check({
      config: { ...DEFAULT_CONFIG, api_key: "asg_test" },
      direction: "input",
      text: canary,
      metadata: { surface: "claude-web" },
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      sleepImpl: async () => undefined,
    });
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join(" ");
    expect(
      logged.includes(canary),
      "a failed check printed the prompt to the console, where it can be read by any " +
        "page script in the same context and by anything scraping browser logs",
    ).toBe(false);
  }, 30_000);
});

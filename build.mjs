// Bundles each MV3 entry point to dist/ (self-contained IIFE — content scripts
// cannot be ES modules) and copies static assets. `node build.mjs [--watch]`.
import esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const entryPoints = {
  background: "src/background.ts",
  "content/main": "src/content/main.ts",
  "content/page-hook": "src/content/page-hook.ts",
  "ui/options": "src/ui/options.ts",
  "ui/popup": "src/ui/popup.ts",
  "ui/welcome": "src/ui/welcome.ts",
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist/ui", { recursive: true });
await mkdir("dist/content", { recursive: true });

async function copyStatic() {
  await cp("manifest.json", "dist/manifest.json");
  await cp("managed_schema.json", "dist/managed_schema.json");
  await cp("src/ui/options.html", "dist/ui/options.html");
  await cp("src/ui/popup.html", "dist/ui/popup.html");
  await cp("src/ui/welcome.html", "dist/ui/welcome.html");
  await cp("icons", "dist/icons", { recursive: true });
}

const opts = {
  entryPoints,
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: "chrome120",
  logLevel: "info",
  // SCRUM-292: the student sign-in's OAuth client id, from the environment at build
  // time only. Unset -> "" -> student mode is "not set up" (fails closed).
  define: { DNEY_GOOGLE_CLIENT_ID: JSON.stringify(process.env.DNEY_GOOGLE_CLIENT_ID ?? "") },
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  await copyStatic();
  console.log("watching for changes...");
} else {
  await esbuild.build(opts);
  await copyStatic();
  console.log("built -> dist/");
}

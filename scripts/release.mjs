// Builds, signs (Mozilla, unlisted) and stages a release:
//   releases/hamsa-<version>.xpi   the signed add-on
//   updates.json                   what Firefox reads to update installed copies by itself
//
// Usage: AMO_JWT_ISSUER=... AMO_JWT_SECRET=... node scripts/release.mjs
// or:    node scripts/release.mjs --env /path/to/amo.env     (KEY=value lines; keep this file outside the repo)
// The keys are read from the environment only and never written anywhere.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension/manifest.json"), "utf8"));
const { version } = manifest;
const id = manifest.browser_specific_settings.gecko.id;
const REPO = "agravaaniresearch/hamsa";

const envAt = process.argv.indexOf("--env");
if (envAt > 0) {
  for (const line of fs.readFileSync(process.argv[envAt + 1], "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) process.env[m[1]] = m[2];
  }
}
const { AMO_JWT_ISSUER: key, AMO_JWT_SECRET: secret } = process.env;
if (!key || !secret) { console.error("Set AMO_JWT_ISSUER and AMO_JWT_SECRET (or pass --env file)."); process.exit(1); }

const out = path.join(root, "releases", `hamsa-${version}.xpi`);
if (fs.existsSync(out)) { console.error(`${out} exists. Bump the version in extension/manifest.json first: Mozilla never signs a version twice.`); process.exit(1); }

const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
run("npm", ["test"]);
run("npm", ["run", "lint"]);
const dist = fs.mkdtempSync(path.join(root, "dist-"));
try {
  run("npx", ["web-ext", "sign", "--source-dir", "extension", "--artifacts-dir", dist, "--channel", "unlisted", "--api-key", key, "--api-secret", secret, "--timeout", "900000"]);
  const signed = fs.readdirSync(dist).find((f) => f.endsWith(".xpi"));
  if (!signed) throw new Error("Mozilla returned no signed file.");
  fs.copyFileSync(path.join(dist, signed), out);
} finally { fs.rmSync(dist, { recursive: true, force: true }); }

// Firefox checks update_url about once a day and installs a newer signed version on its own.
const hash = crypto.createHash("sha256").update(fs.readFileSync(out)).digest("hex");
const updates = { addons: { [id]: { updates: [{ version, update_link: `https://raw.githubusercontent.com/${REPO}/main/releases/hamsa-${version}.xpi`, update_hash: `sha256:${hash}`, applications: { gecko: { strict_min_version: manifest.browser_specific_settings.gecko.strict_min_version } } }] } } };
fs.writeFileSync(path.join(root, "updates.json"), JSON.stringify(updates, null, 2) + "\n");
console.log(`Signed ${path.relative(root, out)} (sha256 ${hash.slice(0, 12)}…) and wrote updates.json. Commit both and push to main.`);

/**
 * Validates deployment configuration without printing any value.
 *   npx tsx scripts/check-env.mts --profile=demo|staging|production|worker [--env-file=path]
 * Reads process.env, or a dotenv-style file given with --env-file (e.g. the output of `vercel env pull`, which you
 * should delete afterwards). Exit code 1 if any error is found.
 */
import { readFileSync } from "node:fs";
import { checkEnv, type Profile } from "../lib/server/config/env-check";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const profile = (arg("profile") ?? "demo") as Profile;
if (!["demo", "staging", "production", "worker"].includes(profile)) {
  console.error("usage: check-env.mts --profile=demo|staging|production|worker [--env-file=path]");
  process.exit(2);
}
let env: Record<string, string | undefined> = process.env;
const file = arg("env-file");
if (file) {
  env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}
const findings = checkEnv(env, profile);
const icon = { error: "ERROR", warn: "WARN ", ok: "OK   " } as const;
console.log(`profile: ${profile}${file ? ` (file: ${file})` : " (process environment)"}`);
for (const x of findings) console.log(`${icon[x.level]} ${x.key}: ${x.message}`);
const errors = findings.filter((x) => x.level === "error").length;
console.log(`\n${errors} error(s), ${findings.filter((x) => x.level === "warn").length} warning(s)`);
process.exit(errors ? 1 : 0);

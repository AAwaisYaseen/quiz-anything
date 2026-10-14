// Fails the build if a server secret ends up in anything the browser can download.
// Runs as `postbuild`, locally and on Vercel. Prints variable names and file paths only, never values.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SECRET_VARS = ["SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY"];

// Shapes of secrets that should never appear in browser files, whatever their value.
const PATTERNS = [
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["Supabase secret key", /sb_secret_[0-9A-Za-z_-]{10,}/],
];

// Values come from the environment (Vercel) or, locally, from .env.local.
// They are only compared in memory.
function secretValues() {
  const fromFile = {};
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) fromFile[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  return SECRET_VARS.map((name) => [name, process.env[name] || fromFile[name] || ""]).filter(
    ([, value]) => value.length >= 8,
  );
}

// Everything served to the browser: static chunks, plus prerendered HTML and RSC payloads.
function browserFiles() {
  const out = [];
  const walk = (dir, filter) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, filter);
      else if (filter(p)) out.push(p);
    }
  };
  walk(".next/static", () => true);
  walk(".next/server/app", (p) => /\.(html|rsc|body)$/.test(p));
  return out;
}

const files = browserFiles();
if (files.length === 0) {
  console.error("check-secrets: no build output found. Run `npm run build` first.");
  process.exit(1);
}

const values = secretValues();
const problems = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [name, value] of values) if (text.includes(value)) problems.push(`${name} in ${file}`);
  for (const [label, re] of PATTERNS) if (re.test(text)) problems.push(`${label} pattern in ${file}`);
}

if (problems.length) {
  console.error("check-secrets: FAILED. Secrets found in browser files:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-secrets: OK. Scanned ${files.length} browser files for ${values.length} secret value(s) and ${PATTERNS.length} key patterns.`,
);

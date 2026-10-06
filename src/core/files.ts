// What YakBarber never copies, searches, shows to the AI, or mounts into a test container —
// in one place, so the scanner and the workspace can't disagree.
import { readdir, rm } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

/** Dependency, cache and tool folders: never customer source code. Skipped at any depth. */
export const DEPENDENCY_DIRS = ["node_modules", "vendor", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".git"];

/** Build output. Skipped only at the top level: a nested folder like src/build/ can be real source. */
export const BUILD_DIRS = ["dist", "build", "coverage", ".next", ".nuxt", "out"];

/** Lock files and generated bundles: large, and never where an integration is written. */
export const GENERATED_FILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "*.min.js", "*.map"];

// Files that hold secrets. A committed secret is still a secret: it must not reach the AI (it would
// be sent to the API) or the test container (untrusted code runs there).
const SECRET_FILE = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production …
  /^\.envrc$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(\.ya?ml)?$/i,
  /^\.pypirc$/i,
  /^_?\.?netrc$/i,
  /^\.git-credentials$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|jks|keystore|gpg|asc|ovpn)$/i,
  /^credentials(\.json)?$/i,
  /service[-_]?account.*\.json$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
  /^\.secrets?$/i,
];
// Templates that only list setting names are fine to keep.
const TEMPLATE_FILE = /^\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".docker", ".kube"]);

/** True for a path (relative, forward slashes) that must never be copied or read. */
export function isSecretFile(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.slice(0, -1).some((s) => SECRET_DIRS.has(s.toLowerCase()))) return true;
  const name = basename(relPath);
  if (TEMPLATE_FILE.test(name)) return false;
  return SECRET_FILE.some((re) => re.test(name));
}

/**
 * Deletes secret files (isSecretFile) from a fresh clone, so nothing that reads the folder afterwards (the whole-code
 * check, a search) can open them. Templates such as .env.example stay. Returns how many were deleted.
 */
export async function dropSecretFiles(dir: string): Promise<number> {
  let dropped = 0;
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const rel = relative(dir, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/") || !isSecretFile(rel)) continue;
    await rm(join(dir, rel), { force: true });
    dropped++;
  }
  return dropped;
}

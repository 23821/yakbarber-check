// Whole-code check, part 1: what outside APIs does this code use? Read from three kinds of evidence, all free:
// the dependency files (npm, Python, Go, PHP, Ruby), the web addresses in the code (api.cartesia.ai), and the
// names of keys it reads (OPENAI_API_KEY). Secret files are never read (listFiles and searchText leave them out).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathKind } from "../campaign/triage.ts";
import { isSecretFile } from "../files.ts";
import { listFiles, searchText } from "../scanner/search.ts";

export type Ecosystem = "npm" | "pypi" | "go" | "composer" | "gem";

export interface PackageUse {
  ecosystem: Ecosystem;
  name: string;
  file: string;
}

/** A web address or key name, with where it appears (code and settings only: docs and tests don't count). */
export interface Evidence {
  value: string;
  files: string[];
}

export interface Inventory {
  packages: PackageUse[];
  /** Modules the code imports (Python: the top-level module; JavaScript: the package), code files only. */
  imports: Evidence[];
  hosts: Evidence[];
  keyNames: Evidence[];
  /** Platforms that change which retirements apply: "vertex" (Google's Vertex AI) and "gemini-api" (the Gemini API). */
  platforms: string[];
}

const DEPENDENCY_FILE = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|go\.mod|composer\.json|Gemfile)$/;

/** Python package names compare lower-case, with "-", "_" and "." the same (PEP 503). */
export const pypiName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/** The packages one dependency file names (no versions). */
export function parseDependencyFile(file: string, text: string): PackageUse[] {
  const name = file.split("/").at(-1)!;
  const out = (ecosystem: Ecosystem, names: string[]) =>
    [...new Set(names.filter(Boolean))].map((n) => ({ ecosystem, name: ecosystem === "pypi" ? pypiName(n) : n, file }));
  if (name === "package.json" || name === "composer.json") {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const keys = name === "package.json" ? ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] : ["require", "require-dev"];
    const names = keys.flatMap((k) => Object.keys((json[k] as Record<string, unknown> | undefined) ?? {}));
    return out(name === "package.json" ? "npm" : "composer", name === "composer.json" ? names.filter((n) => n.includes("/")) : names);
  }
  if (/^requirements[^/]*\.txt$/.test(name)) {
    return out(
      "pypi",
      text
        .split("\n")
        .map((l) => l.replace(/#.*/, "").trim())
        .filter((l) => l && !l.startsWith("-") && !/^[a-z+]+:\/\//i.test(l))
        .map((l) => /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(l)?.[0] ?? ""),
    );
  }
  if (name === "pyproject.toml" || name === "Pipfile") {
    const names: string[] = [];
    let section = "";
    let inArray = false;
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*/, "").trim();
      const header = /^\[+([^\]]+)\]+$/.exec(line);
      if (header) {
        section = header[1]!.trim();
        inArray = false;
        continue;
      }
      // PEP 621 and 735: dependencies = ["httpx>=0.27", …] (one line or several), optional and group lists. Other
      // lists in [project] (keywords, classifiers) are not dependencies.
      const list = /^[\w-]+\s*=\s*\[/.test(line);
      if (list && ((section === "project" && /^dependencies\s*=/.test(line)) || section === "project.optional-dependencies" || section === "dependency-groups")) inArray = true;
      if (inArray) {
        for (const m of line.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.push(m[1]!);
        if (line.includes("]")) inArray = false;
        continue;
      }
      // Poetry and Pipfile tables: name = "^1.2" or name = { version = … }.
      if (/(^|\.)(dependencies|dev-dependencies)$|^packages$|^dev-packages$/.test(section)) {
        const key = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line)?.[1];
        if (key && key.toLowerCase() !== "python") names.push(key);
      }
    }
    return out("pypi", names);
  }
  if (name === "setup.py") {
    const block = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
    return out("pypi", [...block.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)].map((m) => m[1]!));
  }
  if (name === "go.mod") {
    const names: string[] = [];
    let inBlock = false;
    for (const raw of text.split("\n")) {
      const line = raw.replace(/\/\/.*/, "").trim();
      if (/^require\s*\($/.test(line)) inBlock = true;
      else if (inBlock && line === ")") inBlock = false;
      else if (inBlock && line) names.push(line.split(/\s+/)[0]!);
      else if (/^require\s+\S+\s+\S+/.test(line)) names.push(line.split(/\s+/)[1]!);
    }
    return out("go", names);
  }
  if (name === "Gemfile") return out("gem", [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]!));
  return [];
}

// Addresses that say nothing about which APIs a project calls: docs, code hosting, package registries, standards.
const NOISE_HOST =
  /(^|\.)(localhost|example\.(com|org|net)|github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|npmjs\.(com|org)|pypi\.org|python\.org|w3\.org|schema\.org|json-schema\.org|mozilla\.org|wikipedia\.org|shields\.io|opensource\.org|apache\.org|readthedocs\.(io|org)|stackoverflow\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|medium\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|creativecommons\.org|ietf\.org|semver\.org|microsoft\.com\/en-us)$/i;
const HOST = String.raw`https?://[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`;
// Python "import x" / "from x import y" (also inside a function: optional imports), JavaScript import and require.
const PY_IMPORT = String.raw`^\s*(?:from\s+[A-Za-z_][\w.]*\s+import\b|import\s+[A-Za-z_][\w.]*)`;
const JS_IMPORT = String.raw`(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)["'][^"'\s]+["']`;
// Which Google platform the code calls: Vertex AI (a cloud project) or the Gemini API (an API key). Some retirements
// apply to one of them only.
export const VERTEX = String.raw`\bvertex_?ai\b|VertexAI|aiplatform|vertexai\s*[:=]\s*(?:true|True)|GOOGLE_GENAI_USE_VERTEXAI|@google-cloud/vertexai`;
export const GEMINI_API = String.raw`genai\.Client\([^)]*api_key|genai\.configure\(|google\.generativeai|@google/generative-ai|GoogleGenerativeAI|generativelanguage\.googleapis\.com|GEMINI_API_KEY|GOOGLE_API_KEY`;
const KEY_NAME = String.raw`\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:API_KEY|API_TOKEN|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|APIKEY|KEY)\b`;

/** The package or top-level module one import line names, or null for a relative import. */
export function importedModule(text: string): string | null {
  // JavaScript first: its package is always quoted ('import OpenAI from "openai"' is not Python's "import OpenAI").
  const js = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)["']([^"'\s]+)["']/.exec(text)?.[1];
  if (js) {
    if (js.startsWith(".") || js.startsWith("/") || js.startsWith("node:")) return null;
    return js.startsWith("@") ? js.split("/").slice(0, 2).join("/") : js.split("/")[0]!;
  }
  const py = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*))/.exec(text);
  return py ? (py[1] ?? py[2])!.split(".")[0]! : null;
}

/** Where values were found, code and settings only, grouped by value. */
function group(hits: { file: string; value: string }[]): Evidence[] {
  const by = new Map<string, Set<string>>();
  for (const h of hits) {
    if (isSecretFile(h.file)) continue;
    const kind = pathKind(h.file);
    if (kind === "docs" || kind === "test") continue;
    by.set(h.value, (by.get(h.value) ?? new Set()).add(h.file));
  }
  return [...by].map(([value, files]) => ({ value, files: [...files].sort() })).sort((a, b) => a.value.localeCompare(b.value));
}

export async function takeInventory(repoDir: string): Promise<Inventory> {
  const files = (await listFiles(repoDir)).filter((f) => DEPENDENCY_FILE.test(f));
  const packages: PackageUse[] = [];
  for (const file of files) {
    const text = await readFile(join(repoDir, file), "utf8").catch(() => "");
    if (text.length <= 2_000_000) packages.push(...parseDependencyFile(file, text));
  }
  const hostHits = (await searchText(repoDir, [HOST], { regex: true })).flatMap((h) =>
    h.matched.map((m) => ({ file: h.file, value: m.replace(/^https?:\/\//i, "").toLowerCase() })).filter((x) => !NOISE_HOST.test(x.value)),
  );
  const keyHits = (await searchText(repoDir, [KEY_NAME], { regex: true })).flatMap((h) => h.matched.map((m) => ({ file: h.file, value: m })));
  const importHits = (await searchText(repoDir, [PY_IMPORT, JS_IMPORT], { regex: true }))
    .filter((h) => pathKind(h.file) === "code")
    .flatMap((h) => {
      const module = importedModule(h.text);
      return module ? [{ file: h.file, value: module }] : [];
    });
  const platformLines = (await searchText(repoDir, [VERTEX, GEMINI_API], { regex: true })).filter((h) => !isSecretFile(h.file) && (pathKind(h.file) === "code" || pathKind(h.file) === "config"));
  const platforms = [
    ...(platformLines.some((h) => new RegExp(VERTEX).test(h.text)) ? ["vertex"] : []),
    ...(platformLines.some((h) => new RegExp(GEMINI_API).test(h.text)) ? ["gemini-api"] : []),
  ];
  return { packages, imports: group(importHits), hosts: group(hostHits), keyNames: group(keyHits), platforms };
}

// Step 1 of a scan: a plain text search for everything the change spec says to look for.
// Fast and cheap, but it over-matches on purpose; Claude filters the false alarms afterwards.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { rgPath } from "@vscode/ripgrep";
import { execa } from "execa";
import { BUILD_DIRS, DEPENDENCY_DIRS, GENERATED_FILES, isSecretFile } from "../files.ts";
import type { ChangeSpec } from "../spec.ts";

export interface Candidate {
  file: string; // relative to the repository root, forward slashes
  line: number; // 1-based
  text: string; // the matched line, trimmed to a short snippet
  patterns: string[]; // which detect strings / symbols matched on this line
}

const MAX_SNIPPET = 200;

export async function findCandidates(repoDir: string, spec: ChangeSpec): Promise<Candidate[]> {
  const strings = [...new Set(spec.detect.strings)];
  const symbols = [...new Set(spec.detect.sdk_calls.flatMap((c) => c.symbols))];

  const byLocation = new Map<string, Candidate>();
  const add = (hits: RgHit[]) => {
    for (const hit of hits) {
      const key = `${hit.file}:${hit.line}`;
      const existing = byLocation.get(key);
      if (existing) {
        for (const p of hit.patterns) if (!existing.patterns.includes(p)) existing.patterns.push(p);
      } else {
        byLocation.set(key, { file: hit.file, line: hit.line, text: hit.text, patterns: [...hit.patterns] });
      }
    }
  };

  // Literal strings match anywhere; SDK symbols only as whole words (so createCharge doesn't match createChargeback).
  if (strings.length) add(await searchText(repoDir, strings));
  if (symbols.length) add(await withoutNamedArgs(repoDir, spec, await searchText(repoDir, symbols, { wholeWord: true })));

  // Secret files are never passed on (to Claude or anywhere else), even if they mention the API.
  return [...byLocation.values()].filter((c) => !isSecretFile(c.file)).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * For an SDK symbol with `unless_args` (a library default, e.g. ChatOpenAI without `model`), keeps only lines that call
 * it at least once without naming one of those arguments: calls that name one, imports and type hints are dropped
 * before anything is sent to Claude. A call's arguments are read up to its closing bracket, across lines; `**kwargs`
 * the line doesn't show stays in (Claude decides). Symbols without `unless_args` pass through unchanged.
 */
async function withoutNamedArgs(repoDir: string, spec: ChangeSpec, hits: RgHit[]): Promise<RgHit[]> {
  const unless = new Map<string, string[]>();
  for (const c of spec.detect.sdk_calls) for (const s of c.symbols) if (c.unless_args) unless.set(s, [...(unless.get(s) ?? []), ...c.unless_args]);
  if (!unless.size) return hits;
  const files = new Map<string, string[]>();
  const linesOf = async (file: string) => {
    if (!files.has(file)) files.set(file, (await readFile(join(repoDir, file), "utf8").catch(() => "")).split("\n"));
    return files.get(file)!;
  };
  const kept: RgHit[] = [];
  for (const hit of hits) {
    const patterns: string[] = [];
    for (const p of hit.patterns) {
      const args = unless.get(p);
      if (!args) patterns.push(p);
      else if (callsWithout(p, args, (await linesOf(hit.file)).slice(hit.line - 1, hit.line + 59).join("\n"))) patterns.push(p);
    }
    if (patterns.length) kept.push({ ...hit, patterns });
  }
  return kept;
}

/** Whether `text` (starting at the matched line) calls `symbol` at least once on that first line without naming any of
 *  `args` (as `model=`, `model:` or a quoted dict key). */
export function callsWithout(symbol: string, args: string[], text: string): boolean {
  const firstLineEnd = text.indexOf("\n") === -1 ? text.length : text.indexOf("\n");
  const call = new RegExp(String.raw`(?<![\w$])${symbol}\s*\(`, "g");
  const named = new RegExp(String.raw`(?<![\w$])["']?(?:${args.join("|")})["']?\s*[=:](?!=)`);
  for (let m = call.exec(text); m && m.index < firstLineEnd; m = call.exec(text)) {
    // The call's own arguments only: what's inside a nested call or list (`callbacks=[Tracer(model=…)]`) isn't its own,
    // except an options object passed first (`new ChatOpenAI({ model: … })`).
    const start = m.index + m[0].length - 1;
    const options = /^\(\s*\{/.test(text.slice(start, start + 200));
    let own = "";
    let depth = 0;
    for (let i = start; i < text.length && i - m.index < 4000; i++) {
      const ch = text[i]!;
      if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch) && --depth === 0) break;
      else if (depth === 1 || (options && depth === 2)) own += ch;
    }
    if (!named.test(own)) return true;
  }
  return false;
}

export interface RgHit {
  file: string;
  line: number;
  text: string;
  /** The patterns that matched on this line (for a regex search: none, see `matched`). */
  patterns: string[];
  /** The exact texts that matched on this line. */
  matched: string[];
}

/**
 * Searches the repository with ripgrep, skipping dependency folders, top-level build output and generated files.
 * Secret files (isSecretFile) are never opened: the files are listed first and each secret one is left out by its exact
 * path. Literal strings by default; `regex` for patterns.
 */
export async function searchText(cwd: string, patterns: string[], { wholeWord = false, regex = false }: { wholeWord?: boolean; regex?: boolean } = {}): Promise<RgHit[]> {
  const args = [
    "--json",
    "--no-config",
    ...(regex ? [] : ["--fixed-strings"]),
    "--hidden", // include dotfiles such as .github/ and .env.example (.git itself is skipped below)
    "--no-require-git", // honour .gitignore even when the folder is not a git checkout
    "--max-filesize=1M",
    ...(wholeWord ? ["--word-regexp"] : []),
    // Dependency folders at any depth, build output only at the top level; test folders are NOT skipped.
    ...DEPENDENCY_DIRS.map((d) => `--glob=!${d}/`),
    ...BUILD_DIRS.map((d) => `--glob=!/${d}/`),
    ...GENERATED_FILES.map((f) => `--glob=!${f}`),
    ...(await allFiles(cwd)).filter(isSecretFile).map((f) => `--glob=!/${escapeGlob(f)}`),
    ...patterns.flatMap((p) => ["-e", p]),
    ".", // explicit path: without one, ripgrep reads stdin when it isn't a terminal and waits forever
  ];
  const result = await execa(rgPath, args, { cwd, stdin: "ignore", reject: false, maxBuffer: 64 * 1024 * 1024 });
  // ripgrep exits 0 when it found matches, 1 when it found none, 2 on errors.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`ripgrep failed (exit ${result.exitCode}): ${String(result.stderr).slice(0, 500)}`);
  }

  const hits: RgHit[] = [];
  const wanted = new Set(patterns);
  for (const raw of String(result.stdout).split("\n")) {
    if (!raw) continue;
    const event = JSON.parse(raw);
    if (event.type !== "match") continue;
    const file: string | undefined = event.data.path?.text;
    const text: string | undefined = event.data.lines?.text;
    if (file === undefined || text === undefined) continue; // non-UTF-8 path or content
    const matched = [...new Set<string>(event.data.submatches.map((s: { match: { text?: string } }) => s.match.text ?? ""))];
    hits.push({
      file: file.replace(/^\.\//, "").split("\\").join("/"),
      line: event.data.line_number,
      text: snippet(text),
      patterns: regex ? [] : matched.filter((m) => wanted.has(m)),
      matched,
    });
  }
  return hits;
}

/** The repository's files (relative, forward slashes) under the same rules as searchText, secret files left out. */
export async function listFiles(cwd: string): Promise<string[]> {
  return (await allFiles(cwd)).filter((f) => !isSecretFile(f)).sort();
}

/** Every file ripgrep would search (names only: listing a folder opens no file), secret files included. */
async function allFiles(cwd: string): Promise<string[]> {
  const args = [
    "--files",
    "--no-config",
    "--hidden",
    "--no-require-git",
    ...DEPENDENCY_DIRS.map((d) => `--glob=!${d}/`),
    ...BUILD_DIRS.map((d) => `--glob=!/${d}/`),
    ...GENERATED_FILES.map((f) => `--glob=!${f}`),
    ".",
  ];
  const result = await execa(rgPath, args, { cwd, stdin: "ignore", reject: false, maxBuffer: 64 * 1024 * 1024 });
  if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error(`ripgrep failed (exit ${result.exitCode}): ${String(result.stderr).slice(0, 500)}`);
  return String(result.stdout)
    .split("\n")
    .filter(Boolean)
    .map((f) => f.replace(/^\.\//, "").split("\\").join("/"));
}

/** A path as a glob: each glob character becomes "?" (any one character), so a secret file can only be left out with
 *  a near-identical neighbour, never read. */
function escapeGlob(path: string): string {
  return path.replace(/[*?[\]{}\\]/g, "?");
}

function snippet(line: string): string {
  const trimmed = line.replace(/\r?\n$/, "").trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET - 1)}…` : trimmed;
}

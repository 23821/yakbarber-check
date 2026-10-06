// What a line is beyond its own text. Inside a Python docstring or a block comment, example code
// ('llm = ChatOpenAI(model="gpt-4")' in a docstring) is documentation people copy, not a call the project makes.
// Matching and upgrades both read files through repoFiles, which never opens a secret file.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSecretFile } from "../files.ts";

const PYTHON = /\.pyi?$/i;
const C_LIKE = /\.([cm]?[jt]sx?|go|java|kts?|scala|swift|cs|c|cc|cpp|h|hpp|rs|php|dart)$/i;
const MAX_BYTES = 2_000_000;

/** Line numbers (1-based) inside a Python docstring or a block comment. */
export function proseLines(path: string, text: string): Set<number> {
  if (PYTHON.test(path)) return pythonDocstrings(text);
  if (C_LIKE.test(path)) return blockComments(text);
  return new Set();
}

/**
 * A triple-quoted string standing alone as a statement: a docstring (first in a module, class or function) or a
 * string used as a comment. One that is part of an expression (assigned, passed, returned, inside brackets) is code.
 */
function pythonDocstrings(text: string): Set<number> {
  const prose = new Set<number>();
  let line = 1;
  let lineStart = 0;
  let depth = 0; // open brackets
  let last = ""; // the last character of code, outside strings and comments
  let lastBeforeLine = "";
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      lineStart = ++i;
      lastBeforeLine = last;
      continue;
    }
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      const startLine = line;
      const alone = triple && depth === 0 && lastBeforeLine !== "\\" && /^\s*[rRuUbBfF]{0,2}$/.test(text.slice(lineStart, i));
      for (i += quote.length; i < text.length && !text.startsWith(quote, i); i++) {
        if (text[i] === "\\") i++;
        if (text[i] === "\n") {
          if (!triple && text[i - 1] !== "\\") break;
          line++;
          lineStart = i + 1;
        }
      }
      if (text.startsWith(quote, i)) i += quote.length;
      if (alone) for (let l = startLine; l <= line; l++) prose.add(l);
      last = c;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return prose;
}

/** Lines of a /* … *\/ comment. Its first and last line only when no code shares them. */
function blockComments(text: string): Set<number> {
  const prose = new Set<number>();
  let line = 1;
  let lineStart = 0;
  let last = "";
  const skipTo = (i: number, end: number) => {
    for (; i < end; i++) if (text[i] === "\n") (line++, (lineStart = i + 1));
  };
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "\n") {
      line++;
      lineStart = ++i;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const startLine = line;
      const alone = text.slice(lineStart, i).trim() === "";
      const close = text.indexOf("*/", i + 2);
      const end = close === -1 ? text.length : close + 2;
      skipTo(i, end);
      const after = text.slice(end, text.indexOf("\n", end) === -1 ? text.length : text.indexOf("\n", end)).trim();
      for (let l = startLine; l <= line; l++) {
        if ((l === startLine && !alone) || (l === line && after !== "" && !after.startsWith("//"))) continue;
        prose.add(l);
      }
      i = end;
      continue;
    }
    // Strings, and a JavaScript regular expression (after an operator or an opening bracket), may hold "/*" or quotes.
    const regex = c === "/" && (last === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(last));
    if (c === '"' || c === "'" || c === "`" || regex) {
      let j = i + 1;
      for (let inClass = false; j < text.length; j++) {
        const d = text[j]!;
        if (d === "\\") {
          j++;
          continue;
        }
        if (d === "\n" && c !== "`") break;
        if (regex && d === "[") inClass = true;
        else if (regex && d === "]") inClass = false;
        else if (d === c && !inClass) break;
      }
      skipTo(i, Math.min(j, text.length));
      i = text[j] === c ? j + 1 : j;
      last = c;
      continue;
    }
    if (!/\s/.test(c)) last = c;
    i++;
  }
  return prose;
}

/** Lines (1-based) inside a Rust `#[cfg(test)]` module: test code, however much it looks like a call. */
export function testLines(path: string, text: string): Set<number> {
  const out = new Set<number>();
  if (!/\.rs$/i.test(path)) return out;
  const lineAt = (i: number) => text.slice(0, i).split("\n").length;
  for (const m of text.matchAll(/#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g)) {
    let depth = 0;
    let i = m.index! + m[0].length - 1;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    for (let l = lineAt(m.index!); l <= lineAt(i); l++) out.add(l);
  }
  return out;
}

/** A repository's files, read once each (secret files and very large ones never). */
export function repoFiles(repoDir: string) {
  const texts = new Map<string, string | null>();
  const prose = new Map<string, Set<number>>();
  const tests = new Map<string, Set<number>>();
  const text = (file: string): string | null => {
    if (!texts.has(file)) {
      let content: string | null = null;
      try {
        if (!isSecretFile(file) && statSync(join(repoDir, file)).size <= MAX_BYTES) content = readFileSync(join(repoDir, file), "utf8");
      } catch {
        content = null;
      }
      texts.set(file, content);
    }
    return texts.get(file)!;
  };
  return {
    text,
    /** The line is inside a test module (Rust's `#[cfg(test)]`). */
    isTest(file: string, line: number): boolean {
      if (!tests.has(file)) tests.set(file, testLines(file, text(file) ?? ""));
      return tests.get(file)!.has(line);
    },
    /** The line is inside a docstring or a block comment. */
    isProse(file: string, line: number): boolean {
      if (!prose.has(file)) prose.set(file, proseLines(file, text(file) ?? ""));
      return prose.get(file)!.has(line);
    },
  };
}

const COMPARED_BEFORE = /(\.(startswith|startsWith|endswith|endsWith|includes|indexOf|test|match|search|has)\(\s*\(?\s*|[!=]==?\s*|\b(not\s+)?in\s+\(?\s*|\bcase\s+)$/;
const COMPARED_AFTER = /^\s*([!=]==?|(not\s+)?in\b)/;

/**
 * Every quoted string naming one of these values is only compared or matched ('name.startswith("gpt-4")',
 * 'model == "gpt-4"', 'case "gpt-4":', a regular expression r"(^|/)gpt-4\.1$"): the code handles the value if someone
 * picks it, but doesn't send it.
 */
export function onlyCompared(text: string, values: string[]): boolean {
  let named = false;
  for (const m of text.matchAll(/(\b[rR])?(["'`])((?:\\.|(?!\2).)*)\2/g)) {
    const body = m[3]!;
    if (!values.some((v) => body.includes(v))) continue;
    named = true;
    const regex = m[1] !== undefined && /[\\^$|()[\]]/.test(body);
    if (!regex && !COMPARED_BEFORE.test(text.slice(0, m.index)) && !COMPARED_AFTER.test(text.slice(m.index + m[0].length))) return false;
  }
  return named;
}

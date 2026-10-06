// Campaign mode, step "triage": sort the lines a GitHub code search found into what they mean for the project,
// without cloning anything. Rules first (free); the full scanner with Claude only runs later, on the projects picked.
//   call     code that sends the old value: a default, a setting, an argument (the project breaks)
//   config   a settings file or .env example that sets it (the project breaks when used as shipped)
//   option   a list, menu or type that offers it (users who pick it break)
//   docs     documentation or a comment · test: a test file
import type { ChangeSpec } from "../spec.ts";

export type LineKind = "call" | "config" | "option" | "docs" | "test";
export type ProjectKind = "fails" | "offers" | "docs_only" | "tests_only";

export interface FoundLine {
  path: string;
  text: string;
}

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?)\/|(^|\/)[a-z0-9]+[-_]?(tests|e2e)\/|(^|\/)tests?\.rs$|_tests?\.rs$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)conftest\.py$/i;
// Documentation, and translation files (a word there is language, not code: "tavus" is Estonian for "habit").
const DOC_PATH = /\.(md|mdx|rst|txt|adoc|ipynb|html?|lang|po|pot|properties|strings|xliff|xlf|resx|arb|ftl)$|(^|\/)(docs?|documentation|website)\/|(^|\/)(README|CHANGELOG|MIGRATING|CONTRIBUTING)[^/]*$/i;
const CONFIG_PATH = /(^|\/)\.env[^/]*$|\.(ya?ml|toml|ini|cfg|conf)$|(^|\/)(?!package(-lock)?\.json$)[^/]*\.json$/i;
const COMMENT = /^\s*(#(?!!)|\/\/|\/\*|\*(?!\/)|<!--|--\s|;|[│┃])/; // "│" starts a row of a text table
// A name that selects a model, voice or version, then an assignment, default or argument holding the old value.
const SELECTS = String.raw`[\w-]*(?:model|voice|engine|version|tts|stt|speech)[\w-]*`;
const CALL_SHAPES = [
  // model = "old", model: x || "old", model: cond ? "old" : "other" (anything but a list, a type or a new statement between)
  new RegExp(String.raw`\b${SELECTS}["']?\s*(?::\s*[\w.\[\]|<> ]+)?\s*(?:=|:|=>)\s*(?:[^,;\n\[\]{}|]{0,80}?|[\w.]+\s*(?:\?\?|\|\||\bor\b)\s*)OLD`, "i"),
  /\b(?:getenv|environ\.get|env\.get|process\.env\.\w+\s*(?:\?\?|\|\|)|Field|default)\s*\(?[^)\n]{0,80}?OLD/i,
  /(?:\?\?|\|\||\bor\b|\bdefault\s*[:=]?)\s*OLD/i,
  /\b(?:DEFAULT|FALLBACK)[\w]*\s*[:=]\s*OLD/i,
  /\(\s*[^)\n]*["'](?:model|voice)[\w-]*["']\s*,\s*OLD/i, // get(params, "model", "old") — a lookup with a default
];
// A list entry or type, even when a model field holds the old value: { model: "x", name: "X" }, "x" | "y".
const MENU_ENTRY = /\b(name|label|title|display_?name)\s*["']?\s*[:=]/i;

/**
 * The line without a trailing comment (`//`, `#`, `/*`, `<!--` outside a string): "model_id='sonic-3'; //Model (sonic-3,
 * sonic-english)" names sonic-english only in its comment.
 */
export function codeOnly(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && text[i + 1] === "/" && text[i - 1] !== ":") return text.slice(0, i);
    else if (c === "/" && text[i + 1] === "*") return text.slice(0, i);
    else if (c === "<" && text.startsWith("<!--", i)) return text.slice(0, i);
    else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]!)) && text[i + 1] !== "{") return text.slice(0, i);
  }
  return text;
}

/** The old values a line can name: the change spec's strings, as written (quotes included where the spec has them). */
export function oldValues(spec: ChangeSpec): string[] {
  return spec.detect.strings;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A GitHub code search for one old value: the exact phrase, with the company's name next to it when the value alone
 * is too common (Cartesia's "sonic-2" also names a game, a Go library and a word list). Campaign find and leads both use it.
 */
export function codeSearchQuery(value: string, context: string | null = null): string {
  const phrase = `"${value.replace(/^["']|["']$/g, "").replace(/"/g, "")}"`;
  return context ? `${phrase} ${context}` : phrase;
}

/** The old value this line names (exactly, not as part of a longer name), if any. */
export function namedValue(text: string, values: string[]): string | null {
  // Longest first, so "sonic-2-2025-03-07" wins over "sonic-2".
  for (const v of [...values].sort((a, b) => b.length - a.length)) {
    const quoted = /^["'].*["']$/.test(v);
    // A path ("/list-agents") counts right after a quote, a variable or a web address ("…retellai.com/list-agents"),
    // never after another path segment: "/v2/list-agents" is the new endpoint, "/api/retell/list-agents" the
    // project's own route.
    const left = v.startsWith("/") ? String.raw`(?:(?<=^)|(?<=["'\x60\s}(+=:,])|(?<=\.[A-Za-z]{2,24}))` : "(?<![\\w.-])";
    // A dot and a digit after it continue the name: "gpt-4" is not "gpt-4.1-mini" (a full stop still ends it).
    const re = quoted ? new RegExp(escape(v)) : new RegExp(`${left}${escape(v)}(?![\\w-]|\\.\\d)`);
    if (re.test(text)) return v;
  }
  return null;
}

/**
 * `context`: the provider's name. A value that is a plain word (Cartesia's "sonic") only counts on a line that is about
 * the provider or about choosing a model, voice or engine; elsewhere it's another thing with the same name.
 */
export function lineKind(line: FoundLine, values: string[], context?: string): LineKind | null {
  const value = namedValue(line.text, values);
  if (!value) return null;
  if (context && /^["']?[a-z_]+["']?$/i.test(value) && !new RegExp(`${escape(context)}|\\b${SELECTS}\\b`, "i").test(`${line.path} ${line.text}`)) return null;
  if (TEST_PATH.test(line.path)) return "test";
  if (DOC_PATH.test(line.path) || COMMENT.test(line.text) || !namedValue(codeOnly(line.text), values)) return "docs";
  const bare = value.replace(/^["']|["']$/g, "");
  // The value as a string, also with the provider in front or a voice after it: "cartesia/sonic-2:<voice id>".
  const literal = String.raw`["'\`](?:[\w.-]+/)?${escape(bare)}(?::[^"'\`\s]*)?["'\`]`;
  // Settings files: only a key that picks the model counts ("model_id": "old", CARTESIA_MODEL=old); a menu entry or a
  // bare list value there is an option.
  if (CONFIG_PATH.test(line.path)) {
    const setsModel = new RegExp(String.raw`\b${SELECTS}["']?\s*[:=]\s*["']?${escape(bare)}(?![\w-])`, "i").test(line.text);
    return setsModel && !MENU_ENTRY.test(line.text) ? "config" : "option";
  }
  // A model id ("sonic-2", not a path or a field name) outside every quoted string in code is prose: a line of a
  // docstring ("Convert text to audio using Cartesia sonic-2."). A placeholder is a hint, not a choice.
  const inStrings = (codeOnly(line.text).match(/(["'`])(?:\\.|(?!\1).)*\1/g) ?? []).join(" ");
  if (!bare.startsWith("/") && bare.includes("-") && !namedValue(inStrings, values)) return "docs";
  if (new RegExp(String.raw`\bplaceholder=\{?${literal}`, "i").test(line.text)) return "docs";
  const pipe = String.raw`(?<!\|)\|(?!\|)`; // one "|" (a type union), not "||" (a default)
  const typeUnion = new RegExp(`${literal}\\s*${pipe}|${pipe}\\s*${literal}`).test(line.text);
  if (!typeUnion && !MENU_ENTRY.test(line.text) && CALL_SHAPES.some((shape) => new RegExp(shape.source.replaceAll("OLD", literal), shape.flags).test(line.text))) return "call";
  // Offered, not used: a menu entry, a type, a list or set of values, a lookup-table key, an enum member.
  const offered =
    typeUnion ||
    MENU_ENTRY.test(line.text) ||
    new RegExp(String.raw`\bvalue=\{?${literal}`).test(line.text) || // an HTML or JSX menu item: <option value="sonic-2">
    new RegExp(String.raw`^\s*["']?id["']?\s*[:=]\s*${literal}\s*,?\s*(#.*|//.*)?$`).test(line.text) || // a catalogue entry: { "id": "sonic-2", … }
    new RegExp(String.raw`^\s*[\[(]?\s*${literal}\s*[,\])]?\s*(//.*|#.*)?$`).test(line.text) ||
    new RegExp(String.raw`^\s*${literal}\s*[:=]`).test(line.text) ||
    new RegExp(String.raw`["'\`]\s*,\s*${literal}|${literal}\s*,\s*["'\`]`).test(line.text) || // a list of values
    new RegExp(String.raw`^\s*[A-Z]\w*\s*:\s*${literal}\s*,?\s*$`).test(line.text) || // a constant table: SONIC_2: 'sonic-2',
    new RegExp(String.raw`^\s*(?:case\s+[A-Za-z_]\w*|[A-Z]\w*)\s*(=|\()\s*${literal}\s*[,);]?\s*$`).test(line.text); // an enum member
  // Anything else in code uses the old value: a request to the old path, a handler for the old event, a field read.
  return offered ? "option" : "call";
}

/** What kind of file a path is, by its name alone: a test, documentation, a settings file, or code. */
export function pathKind(path: string): "test" | "docs" | "config" | "code" {
  if (TEST_PATH.test(path)) return "test";
  if (DOC_PATH.test(path)) return "docs";
  return CONFIG_PATH.test(path) ? "config" : "code";
}

const RANK: Record<LineKind, number> = { call: 0, config: 1, option: 2, docs: 3, test: 4 };

/** What the lines mean for the whole project, and the lines that decide it (the most serious kind first). */
export function projectKind(lines: FoundLine[], values: string[], context?: string): { kind: ProjectKind; lines: (FoundLine & { lineKind: LineKind })[] } | null {
  const kinds = lines
    .map((l) => ({ ...l, lineKind: lineKind(l, values, context) }))
    .filter((l): l is FoundLine & { lineKind: LineKind } => l.lineKind !== null)
    .sort((a, b) => RANK[a.lineKind] - RANK[b.lineKind]);
  const top = kinds[0]?.lineKind;
  if (!top) return null;
  const kind: ProjectKind = top === "call" || top === "config" ? "fails" : top === "option" ? "offers" : top === "docs" ? "docs_only" : "tests_only";
  return { kind, lines: kinds };
}

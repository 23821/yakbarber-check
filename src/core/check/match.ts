// Whole-code check, part 3: which lines name something on the radar? One search for every name on it (timeline and
// "already switched off"), then each line is sorted with the campaign rules (call, config, option, docs, test). A line
// only counts for a company the project uses, or when the line itself names that company: "o3" in a README of a
// project that never calls OpenAI is not an OpenAI finding.
import { lineKind, pathKind, type LineKind } from "../campaign/triage.ts";
import { isSecretFile } from "../files.ts";
import { searchText } from "../scanner/search.ts";
import { GEMINI_API, VERTEX } from "./inventory.ts";
import { onlyCompared, repoFiles } from "./lines.ts";
import { compact, namesOf } from "./providers.ts";
import type { RadarData, RadarDataEntry } from "./radar.ts";

export interface Finding {
  entry: RadarDataEntry;
  file: string;
  line: number;
  text: string;
  kind: LineKind;
}

export interface MatchResult {
  findings: Finding[];
  /** Lines naming something on the radar for a company the project shows no sign of using (left out). */
  unrelated: number;
}

// Names too short or too common to search for on their own.
// A bare version ("v2.x", "/v1/", "1.16") names no company: it appears in every project's settings and routes.
export const searchable = (id: string) => id.trim().length >= 2 && !/^(\/?v?\d+(\.(\d+|x|\*))*\/?|api|sdk)$/i.test(id.trim());

// Prefixes that name the company a model is called through ("xai/grok-3", LiteLLM's "vertex_ai/gemini-2.5-flash"),
// beyond the companies' own names. "vertex_ai" and "gemini" also say which Google platform it is.
const PREFIXES: Record<string, string> = {
  vertexai: "google",
  gemini: "google",
  googleai: "google",
  azure: "azure-openai",
  azureai: "azure-openai",
  bedrock: "aws-bedrock",
  togetherai: "together-ai",
  fireworksai: "fireworks-ai",
};

// Companies that sell other companies' models under the same names (Azure OpenAI's "gpt-4", "grok-3"): a bare name
// in code is the original company's, so their retirements need the line or the file to be about them.
const RESELLERS: Record<string, RegExp> = { "azure-openai": /azure/i };

// Model families and the companies that make them. A company that retires another maker's model (CometAPI or Nebius
// stopping gpt-4o or Qwen, Groq stopping a Llama) retires it on its own platform only: the line or the file must be
// about that company. Matched on the last part of the id ("Qwen/Qwen3-30B" → "Qwen3-30B"), so a host's own form of the
// id ("anthropic.claude-…" on Bedrock) isn't affected.
const MAKERS: [RegExp, string[]][] = [
  [/^(gpt|o[1-9]\b|o[1-9]-|dall-e|whisper|tts-1|chatgpt|davinci|babbage|text-embedding|sora)/i, ["openai", "azure-openai"]],
  [/^claude/i, ["anthropic"]],
  [/^(gemini|gemma|imagen|veo)/i, ["google"]],
  [/^(meta-)?llama/i, ["meta"]],
  [/^(qwen|qwq)/i, ["qwen", "alibaba"]],
  [/^deepseek/i, ["deepseek"]],
  [/^(mistral|mixtral|devstral|codestral|magistral|ministral|pixtral)/i, ["mistral"]],
  [/^(glm|zai-glm|chatglm)/i, ["zhipu", "zai"]],
  [/^kimi/i, ["moonshot"]],
  [/^minimax/i, ["minimax"]],
  [/^grok/i, ["xai"]],
];
const anotherMakersModel = (entry: RadarDataEntry, ids: string[]) =>
  entry.kind === "model" &&
  ids.some((id) => {
    const maker = MAKERS.find(([re]) => re.test(id.split("/").pop()!));
    return maker !== undefined && !maker[1].includes(entry.providerId);
  });
// A plain word as an identifier ("messages", "is_validated") is too common to stand for one company on its own, and so
// is a path many APIs share ("/v1/chat/completions", "/v1/images/generations", Anthropic's and WhatsApp's "/v1/messages").
// So is a dotted method name ("files.upload", "chat.postMessage"): other code has methods by the same name.
const plainWord = (id: string) =>
  /^[a-z][a-z_]*$/i.test(id) ||
  (/^[a-z]+(\.[a-z][a-z_]*)+$/i.test(id) && !/\.(com|io|ai|net|org|dev|co|app|cloud)$/i.test(id)) || // not a web address
  /^\/?(v\d+\/)?(chat\/completions|completions|embeddings|responses|models|messages|images\/(generations|edits|variations)|audio\/(speech|transcriptions|translations))\/?$/i.test(id);

// A runtime name ("python3.10", "nodejs20.x", "java17", "go122") is in every project that uses that language. A runtime
// retirement counts only in a file that deploys to that company's platform (a Lambda or Cloud Functions setting).
const RUNTIME_ID = /^(?:--runtime=|runtime: )?(python|nodejs|node|java|dotnet|ruby|go|provided)[\d.]*(\.x|\.al2)?$/i;
const RUNTIME_PLATFORM: Record<string, RegExp> = {
  aws: /lambda|serverless|AWS::|aws_cdk|aws-cdk|\bsam\b/i,
  "google-cloud": /gcloud|cloudfunctions|functions[-_]framework|cloud ?functions|cloud ?run/i,
  vercel: /vercel/i,
};
const deploysThere = (providerId: string, file: string, text: string | null) =>
  (RUNTIME_PLATFORM[providerId] ?? new RegExp(providerId.replace(/[^a-z0-9]+/gi, ".?"), "i")).test(`${file}\n${text ?? ""}`);

/**
 * A name that doesn't stand for this company on its own: a plain word, a path every OpenAI-style API shares, another
 * maker's model the company also serves, or a reseller's copy of a name. A line (or a code search) must also name the
 * company. The same rules decide which lines count in matchRadar.
 */
export function needsCompanyNamed(entry: RadarDataEntry, id: string): boolean {
  return plainWord(id) || anotherMakersModel(entry, [id]) || RESELLERS[entry.providerId] !== undefined;
}

/** One of the names appears inside quotes or backticks on the line ("gpt-4", 'openai/gpt-4', `${p}/gpt-4`). */
function quoted(text: string, identifiers: string[]): boolean {
  return identifiers.some((id) => new RegExp(`["'\x60][^"'\x60]*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^"'\x60]*["'\x60]`).test(text));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The prefixes in front of this entry's names on the line ("xai" in "xai/grok-3-mini"), compacted. */
function prefixesOn(text: string, identifiers: string[]): string[] {
  return identifiers.flatMap((id) => [...text.matchAll(new RegExp(`([A-Za-z][\\w.-]*)/${escapeRe(id)}(?![\\w-]|\\.\\d)`, "g"))].map((m) => compact(m[1]!)));
}

const VERTEX_SIGNS = new RegExp(VERTEX);
const GEMINI_API_SIGNS = new RegExp(GEMINI_API);
type Platform = "vertex" | "gemini-api";

/** The one Google platform a file's code calls, when it shows exactly one. */
function filePlatform(text: string | null): Platform | null {
  const vertex = VERTEX_SIGNS.test(text ?? "");
  return vertex === GEMINI_API_SIGNS.test(text ?? "") ? null : vertex ? "vertex" : "gemini-api";
}

/**
 * A retirement on one platform only (Google retires a model on Vertex AI but not yet on the Gemini API, or the other way
 * round). Decided by the line first (LiteLLM's "gemini/…" is the Gemini API, "vertex_ai/…" is Vertex AI), then by the
 * file (genai.Client(api_key=…) is the Gemini API), then, for a file that doesn't say (a settings table), by the other
 * files naming the same model, and last by the whole project.
 */
function platformApplies(entry: RadarDataEntry, where: string, prefixes: string[], file: () => Platform | null, sameModel: () => Set<Platform>, platforms: string[]): boolean {
  const vertexOnly = /vertex ai/i.test(entry.what) && !/gemini api/i.test(entry.what);
  const geminiApiOnly = /gemini api/i.test(entry.what) && !/vertex ai/i.test(entry.what);
  if (!vertexOnly && !geminiApiOnly) return true;
  const on = (platform: Platform) => (platform === "vertex" ? vertexOnly : geminiApiOnly);
  if (prefixes.includes("gemini")) return on("gemini-api");
  if (prefixes.includes("vertexai") || /vertex/i.test(where)) return on("vertex");
  const own = file();
  if (own) return on(own);
  const others = sameModel();
  if (others.size === 1) return on([...others][0]!);
  if (vertexOnly) return platforms.includes("vertex");
  return !platforms.includes("vertex") || platforms.includes("gemini-api");
}

export async function matchRadar(repoDir: string, radar: RadarData, usedIds: Set<string>, platforms: string[] = []): Promise<MatchResult> {
  const entries = [...radar.entries, ...radar.earlier];
  const byName = new Map<string, RadarDataEntry[]>();
  for (const e of entries) for (const id of e.identifiers.filter(searchable)) byName.set(id, [...(byName.get(id) ?? []), e]);
  if (!byName.size) return { findings: [], unrelated: 0 };

  const providers = new Map(radar.providers.map((p) => [p.id, p]));
  const prefixOwner = (prefix: string): string | null => PREFIXES[prefix] ?? radar.providers.find((p) => namesOf(p).includes(prefix))?.id ?? null;
  const names = [...byName.keys()];
  const hits = (await searchText(repoDir, names)).filter((h) => !isSecretFile(h.file));
  const files = repoFiles(repoDir);
  const platformOf = new Map<string, Platform | null>();
  const fileOn = (file: string) => {
    if (!platformOf.has(file)) platformOf.set(file, pathKind(file) === "docs" ? null : filePlatform(files.text(file)));
    return platformOf.get(file)!;
  };
  const sameModel = new Map<string, Set<Platform>>();
  const platformsNaming = (entry: RadarDataEntry) => {
    if (!sameModel.has(entry.id)) {
      const exact = entry.identifiers.filter(searchable).map((id) => new RegExp(`${escapeRe(id)}(?![\\w-]|\\.\\d)`));
      const found = new Set<Platform>();
      for (const h of hits.filter((h) => exact.some((re) => re.test(h.text)))) {
        const platform = fileOn(h.file);
        if (platform) found.add(platform);
      }
      sameModel.set(entry.id, found);
    }
    return sameModel.get(entry.id)!;
  };
  const findings = new Map<string, Finding>();
  let unrelated = 0;
  for (const hit of hits) {
    const where = compact(`${hit.file} ${hit.text}`);
    // ripgrep reports one match per spot, the first name that fits ("sonic" in "sonic-2"), so read every name on the line.
    const onLine = new Set([...hit.patterns, ...names.filter((n) => hit.text.includes(n))]);
    for (const entry of new Set([...onLine].flatMap((p) => byName.get(p) ?? []))) {
      const provider = providers.get(entry.providerId);
      const named = provider ? namesOf(provider).some((n) => n.length >= 4 && where.includes(n)) : false;
      // A line that says which company it calls ("xai/grok-3-mini") only counts for that company.
      const prefixes = prefixesOn(hit.text, entry.identifiers.filter(searchable));
      const owners = prefixes.map(prefixOwner).filter((o): o is string => o !== null);
      const otherCompany = (owners.length > 0 && !owners.includes(entry.providerId)) || (RESELLERS[entry.providerId] !== undefined && !RESELLERS[entry.providerId]!.test(`${hit.file} ${hit.text}`));
      // Its own platform only: another maker's model, or a plain word, counts where the line or file is about the company.
      const ownPlatformOnly = anotherMakersModel(entry, entry.identifiers.filter(searchable)) || [...onLine].filter((n) => byName.get(n)?.includes(entry)).every(plainWord);
      const aboutCompany = named || owners.includes(entry.providerId) || (RESELLERS[entry.providerId]?.test(`${hit.file} ${hit.text}`) ?? false);
      const mine = [...onLine].filter((n) => byName.get(n)?.includes(entry));
      if (mine.length && mine.every((n) => RUNTIME_ID.test(n)) && !deploysThere(entry.providerId, hit.file, files.text(hit.file))) {
        unrelated++;
        continue;
      }
      if ((!usedIds.has(entry.providerId) && !named) || (ownPlatformOnly && !aboutCompany) || otherCompany || !platformApplies(entry, `${hit.file} ${hit.text}`, prefixes, () => fileOn(hit.file), () => platformsNaming(entry), platforms)) {
        unrelated++;
        continue;
      }
      let kind = lineKind({ path: hit.file, text: hit.text }, entry.identifiers.filter(searchable), entry.providerName);
      if (!kind) continue; // only part of a longer name ("gpt-4" in "gpt-4.1-mini")
      // Code sends a model as a string: a model name outside quotes on a code line is prose (a docstring or comment).
      if (kind === "call" && entry.kind === "model" && !quoted(hit.text, entry.identifiers.filter(searchable))) kind = "docs";
      // A name that is only compared ("startswith('gpt-4')") is handled, not sent: like a menu entry.
      if (kind === "call" && onlyCompared(hit.text, entry.identifiers.filter(searchable))) kind = "option";
      // Test code inside a source file (Rust's #[cfg(test)] modules) is a test.
      if (kind !== "test" && files.isTest(hit.file, hit.line)) kind = "test";
      // Example code in a docstring or a block comment is documentation, however much it looks like a call.
      if (kind !== "test" && files.isProse(hit.file, hit.line)) kind = "docs";
      const key = `${entry.id}|${hit.file}|${hit.line}`;
      if (!findings.has(key)) findings.set(key, { entry, file: hit.file, line: hit.line, text: hit.text, kind });
    }
  }
  return { findings: [...findings.values()], unrelated };
}

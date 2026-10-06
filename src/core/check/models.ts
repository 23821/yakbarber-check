// Whole-code check, models in use: where the code names a model from the model catalogue (radar/models/<job>.json:
// text to speech, speech to text), whether or not it is retiring, so the developer dashboard can compare it with the
// same company's other models and their prices (mockup d). Same rules as upgrades: only lines that name the model as a
// string in code, a setting or a menu count, never docs, tests or prose in a docstring; secret files are never opened.
import { lineKind, type LineKind } from "../campaign/triage.ts";
import { isSecretFile } from "../files.ts";
import { searchText } from "../scanner/search.ts";
import { repoFiles } from "./lines.ts";

export interface CatalogueModel {
  job: string; // text-to-speech, speech-to-text
  id: string; // the id the code passes to the API
  aliases: string[]; // snapshot ids naming the same model
  providerName: string; // a plain-word id only counts next to the company's name (lineKind's context)
}

export interface ModelUse {
  job: string;
  model: string; // the catalogue id (an alias found counts for its model)
  named: string; // the id as the code writes it
  lines: { file: string; line: number; text: string; kind: LineKind }[];
}

const KEEP: LineKind[] = ["call", "config", "option"];
const RANK: Record<LineKind, number> = { call: 0, config: 1, option: 2, docs: 3, test: 4 };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quoted = (text: string, id: string) => new RegExp(`["'\x60][^"'\x60]*${escapeRe(id)}[^"'\x60]*["'\x60]`).test(text);

export async function findModelUses(repoDir: string, catalogue: CatalogueModel[]): Promise<ModelUse[]> {
  const names = new Map<string, CatalogueModel>(); // every id and alias → its model
  for (const m of catalogue) for (const n of [m.id, ...m.aliases]) if (n.trim().length >= 4) names.set(n, m);
  if (!names.size) return [];
  const hits = (await searchText(repoDir, [...names.keys()])).filter((h) => !isSecretFile(h.file));
  const files = repoFiles(repoDir);
  const uses = new Map<string, ModelUse>();
  for (const hit of hits) {
    // A menu can name several models; lineKind checks each is named whole ("tts-1-hd" isn't "tts-1").
    for (const named of [...names.keys()].filter((n) => hit.text.includes(n))) {
      const m = names.get(named)!;
      let kind = lineKind({ path: hit.file, text: hit.text }, [named], m.providerName);
      if (!kind) continue;
      if (kind === "call" && !quoted(hit.text, named)) kind = "docs"; // a model is sent as a string: outside quotes it's prose
      if (files.isProse(hit.file, hit.line)) kind = "docs";
      if (!KEEP.includes(kind)) continue;
      const key = `${m.job}|${m.id}`;
      const use = uses.get(key) ?? { job: m.job, model: m.id, named, lines: [] };
      if (!use.lines.some((l) => l.file === hit.file && l.line === hit.line)) use.lines.push({ file: hit.file, line: hit.line, text: hit.text, kind });
      uses.set(key, use);
    }
  }
  for (const u of uses.values()) u.lines.sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.file.localeCompare(b.file) || a.line - b.line);
  return [...uses.values()].sort((a, b) => a.job.localeCompare(b.job) || a.model.localeCompare(b.model));
}

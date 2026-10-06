// Whole-code check, upgrades: for a company the project uses, where its code names an older option that still works
// and the company offers a newer one ("you call sonic-3.5; Cartesia now offers sonic-3.6"). The radar's upgrades come
// from the company's own pages (apps/radar UpgradeSchema). Nothing here is being retired: a name that is on the radar
// as a retirement is left to that finding. Only lines that really name the option in code, a setting or a menu count.
import { lineKind, type LineKind } from "../campaign/triage.ts";
import { isSecretFile } from "../files.ts";
import { searchText } from "../scanner/search.ts";
import { repoFiles } from "./lines.ts";
import type { RadarData, RadarUpgrade } from "./radar.ts";

export interface UpgradeItem {
  providerId: string;
  providerName: string;
  upgrade: RadarUpgrade;
  /** The names from `upgrade.from` the code really uses. */
  using: string[];
  lines: { file: string; line: number; text: string; kind: LineKind }[];
}

const KEEP: LineKind[] = ["call", "config", "option"];
const RANK: Record<LineKind, number> = { call: 0, config: 1, option: 2, docs: 3, test: 4 };
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const quoted = (text: string, id: string) => new RegExp(`["'\x60][^"'\x60]*${escapeRe(id)}[^"'\x60]*["'\x60]`).test(text);

export async function findUpgrades(repoDir: string, radar: RadarData, usedIds: Set<string>): Promise<UpgradeItem[]> {
  const retiring = new Map<string, Set<string>>(); // company → names the radar says retire (the retirement report has them)
  for (const e of [...radar.entries, ...radar.earlier]) retiring.set(e.providerId, new Set([...(retiring.get(e.providerId) ?? []), ...e.identifiers]));

  const wanted = radar.providers
    .filter((p) => usedIds.has(p.id) && p.upgrades.length)
    .flatMap((p) => p.upgrades.map((upgrade) => ({ provider: p, upgrade, from: upgrade.from.filter((id) => id.trim().length >= 4 && !retiring.get(p.id)?.has(id)) })))
    .filter((w) => w.from.length);
  if (!wanted.length) return [];

  const names = [...new Set(wanted.flatMap((w) => w.from))];
  const hits = (await searchText(repoDir, names)).filter((h) => !isSecretFile(h.file));
  const files = repoFiles(repoDir);
  const items: UpgradeItem[] = [];
  for (const w of wanted) {
    const lines = new Map<string, UpgradeItem["lines"][number]>();
    const using = new Set<string>();
    for (const hit of hits) {
      for (const id of w.from.filter((f) => hit.text.includes(f))) {
        let kind = lineKind({ path: hit.file, text: hit.text }, [id], w.provider.name);
        if (!kind) continue; // only part of a longer name
        if (kind === "call" && !quoted(hit.text, id)) kind = "docs"; // a model is sent as a string: outside quotes it's prose
        if (files.isProse(hit.file, hit.line)) kind = "docs"; // example code in a docstring or a block comment
        if (!KEEP.includes(kind)) continue;
        using.add(id);
        lines.set(`${hit.file}:${hit.line}`, { file: hit.file, line: hit.line, text: hit.text, kind });
      }
    }
    if (lines.size) {
      const sorted = [...lines.values()].sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.file.localeCompare(b.file) || a.line - b.line);
      items.push({ providerId: w.provider.id, providerName: w.provider.name, upgrade: w.upgrade, using: [...using], lines: sorted });
    }
  }
  return items.sort((a, b) => a.providerName.localeCompare(b.providerName) || a.upgrade.to.localeCompare(b.upgrade.to));
}

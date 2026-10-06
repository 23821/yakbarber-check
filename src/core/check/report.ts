// Whole-code check, part 4: one report per project. Broken now, due within 90 days, later, offered in a menu,
// and mentions in docs and tests; each with the file and line, what to use instead, the price change and the
// company's own words. Plus the outside APIs the radar doesn't cover yet (to research).
import type { LineKind } from "../campaign/triage.ts";
import type { Inventory } from "./inventory.ts";
import type { Finding } from "./match.ts";
import type { UsedProvider } from "./providers.ts";
import type { UpgradeItem } from "./upgrades.ts";
import type { RadarAlternative, RadarCost, RadarData, RadarDataEntry } from "./radar.ts";

export type Section = "broken" | "soon" | "later" | "offered" | "mentioned";

export interface ReportItem {
  entry: RadarDataEntry;
  section: Section;
  /** Whole days until the switch-off; negative once it has passed. */
  days: number;
  lines: { file: string; line: number; text: string; kind: LineKind }[];
}

export interface CheckReport {
  repository: string;
  checkedOn: string;
  radarChecked: string;
  radarSize: { retirements: number; companies: number };
  used: UsedProvider[];
  packages: number;
  items: ReportItem[];
  /** Newer options from companies the project uses, for things that still work (nothing retires them). */
  upgrades: UpgradeItem[];
  uncovered: { hosts: string[]; keyNames: string[] };
  unrelated: number;
}

// Key names that belong to the project itself or its tooling, not to an outside API.
const GENERIC_KEY = /^(SECRET|JWT|APP|AUTH|API|ACCESS|PRIVATE|PUBLIC|SESSION|CSRF|ENCRYPTION|SIGNING|MASTER|ADMIN|DB|DATABASE|REDIS|POSTGRES|MYSQL|MONGO|GITHUB|GH|NPM|PYPI|NODE|DJANGO|FLASK|NEXTAUTH|NEXT_PUBLIC|VITE|REACT_APP|CI|DOCKER|SSH|GPG|TEST|LOCAL|DEV|PROD|SERVICE|CLIENT|USER|INTERNAL|WEBHOOK)(_|$)/;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const RANK: Record<LineKind, number> = { call: 0, config: 1, option: 2, docs: 3, test: 4 };

export function buildCheckReport(options: {
  repository: string;
  radar: RadarData;
  inventory: Inventory;
  used: UsedProvider[];
  findings: Finding[];
  unrelated: number;
  uncoveredHosts: string[];
  upgrades?: UpgradeItem[];
  today: Date;
}): CheckReport {
  const { radar, findings, today } = options;
  const checkedOn = isoDay(today);
  const byEntry = new Map<string, Finding[]>();
  for (const f of findings) byEntry.set(f.entry.id, [...(byEntry.get(f.entry.id) ?? []), f]);
  const items: ReportItem[] = [...byEntry.values()].map((list) => {
    const entry = list[0]!.entry;
    const days = daysBetween(checkedOn, entry.date);
    const lines = list.map(({ file, line, text, kind }) => ({ file, line, text, kind })).sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.file.localeCompare(b.file) || a.line - b.line);
    const top = lines[0]!.kind;
    const breaks = top === "call" || top === "config";
    // A migration deadline isn't an announced switch-off: once passed, it's urgent, but we don't call it broken.
    const migrate = entry.deadline === "migrate-by";
    const section: Section = !breaks ? (top === "option" ? "offered" : "mentioned") : days < 0 && !migrate ? "broken" : days <= 90 ? "soon" : "later";
    return { entry, section, days, lines };
  });
  items.sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.entry.providerName.localeCompare(b.entry.providerName));
  const keyNames = options.inventory.keyNames
    .map((k) => k.value)
    .filter((k) => !GENERIC_KEY.test(k) && !options.used.some((u) => u.reasons.some((r) => r.startsWith(`${k} `))));
  return {
    repository: options.repository,
    checkedOn,
    radarChecked: radar.checked,
    radarSize: { retirements: radar.entries.length + radar.earlier.length, companies: radar.providers.length },
    used: options.used,
    packages: options.inventory.packages.length,
    items,
    upgrades: options.upgrades ?? [],
    uncovered: { hosts: options.uncoveredHosts, keyNames },
    unrelated: options.unrelated,
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (iso: string, precision: "day" | "month" = "day") => {
  const d = new Date(`${iso}T00:00:00Z`);
  return precision === "month" ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const KIND_WORDS: Record<LineKind, string> = { call: "code", config: "setting", option: "menu or list", docs: "docs", test: "test" };
const shortLine = (text: string) => (text.length > 120 ? `${text.slice(0, 119)}…` : text).replace(/`/g, "'");

/** When a retirement happens, in words: a migration deadline is never called a switch-off (or "breaks"). */
export function deadlineWords(entry: Pick<RadarDataEntry, "date" | "precision" | "deadline">, days: number): string {
  const date = longDate(entry.date, entry.precision);
  if (entry.deadline === "migrate-by") return days < 0 ? `deadline to migrate was ${date}` : `migrate by ${date}, in ${days} day${days === 1 ? "" : "s"}`;
  if (days < 0) return `switched off ${date}`;
  if (days === 0) return `switches off today, ${date}`;
  return `switches off ${date}, in ${days} day${days === 1 ? "" : "s"}`;
}

const when = (item: ReportItem) => deadlineWords(item.entry, item.days);

const MAX_ALTERNATIVES = 5;

/** One of the company's alternatives: its price, the change against today's, its own words, and its own date if any. */
function alternativeLine(alt: RadarAlternative, oldCost: RadarCost | null): string {
  const parts = [`\`${alt.name}\`${alt.recommended ? " (their pick)" : ""}`];
  const change = costChange(oldCost, alt.cost);
  if (alt.price) parts.push(`: ${alt.price}${change ? `, ${change}` : ""}${alt.priceUrl ? ` ([prices](${alt.priceUrl})${alt.checked ? `, ${alt.checked}` : ""})` : ""}`);
  let line = parts.join("");
  if (alt.says) line += `. They say: "${alt.says}"${alt.saysUrl ? ` ([source](${alt.saysUrl}))` : ""}`;
  if (alt.retires) line += `. Itself retires ${longDate(alt.retires)}`;
  return line;
}

/** "25% cheaper", "2.8× the price": only when both prices use the same unit and currency. */
export function costChange(oldCost: RadarCost | null, cost: RadarCost | null): string | null {
  if (!oldCost || !cost || oldCost.unit !== cost.unit || oldCost.currency !== cost.currency) return null;
  const one = (from: number, to: number) => {
    if (from <= 0) return null;
    const r = to / from;
    if (Math.abs(r - 1) < 0.005) return "same price";
    if (r < 1) return `${Math.round((1 - r) * 100)}% cheaper`;
    return r < 2 ? `${Math.round((r - 1) * 100)}% more` : `${r.toFixed(1).replace(/\.0$/, "")}× the price`;
  };
  const input = one(oldCost.price, cost.price);
  const output = oldCost.outputPrice != null && cost.outputPrice != null ? one(oldCost.outputPrice, cost.outputPrice) : null;
  if (!input) return null;
  return output && output !== input ? `input ${input}, output ${output}` : input;
}

function upgradeBlock(u: UpgradeItem, maxLines = 5): string {
  const x = u.upgrade;
  const out = [`### ${u.providerName}: \`${u.using.join("`, `")}\` → \`${x.to}\``, ""];
  out.push(`- **They say:** "${x.says}" ([source](${x.saysUrl}))`);
  const change = costChange(x.oldCost, x.cost);
  const prices = [x.oldPrice && `now ${x.oldPrice}`, x.price && `${x.to}: ${x.price}`].filter(Boolean).join("; ");
  if (prices || change) out.push(`- **Price:** ${[prices, change].filter(Boolean).join(", ")}${x.priceUrl ? ` ([prices](${x.priceUrl})${x.checked ? `, ${x.checked}` : ""})` : ""}`);
  out.push(`- **In this code:**`);
  for (const l of u.lines.slice(0, maxLines)) out.push(`  - \`${l.file}:${l.line}\` (${KIND_WORDS[l.kind]}): \`${shortLine(l.text)}\``);
  if (u.lines.length > maxLines) out.push(`  - and ${u.lines.length - maxLines} more line${u.lines.length - maxLines === 1 ? "" : "s"}`);
  return out.join("\n");
}

function block(item: ReportItem, maxLines = 8): string {
  const e = item.entry;
  const out = [`### ${e.providerName}: ${e.what} (${when(item)})`, ""];
  if (e.impact) out.push(`- **${e.deadline === "migrate-by" ? "What happens" : "What breaks"}:** ${e.impact}`);
  out.push(`- **Use instead:** ${e.replacement ? `\`${e.replacement}\`` : "no direct replacement named"}`);
  if (e.price) {
    const parts = [e.price.old && `old ${e.price.old}`, e.price.new && `new ${e.price.new}`].filter(Boolean).join("; ");
    out.push(`- **Price:** ${parts}${e.price.change ? ` (${e.price.change})` : ""} ([prices](${e.price.sourceUrl}), ${e.price.checked})`);
  }
  if (e.alternatives.length) {
    out.push(`- **${e.providerName}'s options:**`);
    for (const alt of e.alternatives.slice(0, MAX_ALTERNATIVES)) out.push(`  - ${alternativeLine(alt, e.oldCost)}`);
    if (e.alternatives.length > MAX_ALTERNATIVES) out.push(`  - and ${e.alternatives.length - MAX_ALTERNATIVES} more on the radar`);
  }
  out.push(`- **In this code:**`);
  for (const l of item.lines.slice(0, maxLines)) out.push(`  - \`${l.file}:${l.line}\` (${KIND_WORDS[l.kind]}): \`${shortLine(l.text)}\``);
  if (item.lines.length > maxLines) out.push(`  - and ${item.lines.length - maxLines} more line${item.lines.length - maxLines === 1 ? "" : "s"}`);
  out.push(`- **Their words:** "${e.quote}" ([${e.providerName}'s notice](${e.sourceUrl}))`);
  if (e.changeId) out.push(`- **YakBarber can fix this:** change \`${e.changeId}\``);
  return out.join("\n");
}

const SECTIONS: { section: Section; title: string; note: string }[] = [
  { section: "broken", title: "Broken now", note: "Switched off already: these calls fail today." },
  { section: "soon", title: "Due in the next 90 days", note: "" },
  { section: "later", title: "Due later", note: "" },
  { section: "offered", title: "Offered in a menu or list", note: "Not called by default, but whoever picks one of these gets an error." },
];

export function renderCheckMarkdown(r: CheckReport): string {
  const count = (s: Section) => r.items.filter((i) => i.section === s).length;
  const out = [
    `# What's retiring in ${r.repository}`,
    "",
    `Checked ${longDate(r.checkedOn)} against the Retirement Radar (${r.radarSize.retirements} retirements from ${r.radarSize.companies} companies, research of ${longDate(r.radarChecked)}; https://yakbarber.com/radar/). Every date and quote is from the company's own page.`,
    "",
    `**${count("broken")} broken now · ${count("soon")} due in the next 90 days · ${count("later")} later · ${count("offered")} offered in a menu${r.upgrades.length ? ` · ${r.upgrades.length} newer option${r.upgrades.length === 1 ? "" : "s"}` : ""}**`,
    "",
    "## Outside APIs this code uses",
    "",
    ...(r.used.length ? r.used.map((u) => `- **${u.name}:** ${u.reasons.slice(0, 3).join("; ")}${u.reasons.length > 3 ? `; and ${u.reasons.length - 3} more` : ""}`) : ["- None of the radar's companies (from its dependency files, addresses and key names)."]),
    "",
  ];
  for (const s of SECTIONS) {
    const items = r.items.filter((i) => i.section === s.section);
    if (!items.length) continue;
    out.push(`## ${s.title} (${items.length})`, "");
    if (s.note) out.push(s.note, "");
    for (const item of items) out.push(block(item), "");
  }
  if (r.upgrades.length) {
    out.push(`## Newer options from companies you already use (${r.upgrades.length})`, "", "Nothing here is being retired. These are the company's own newer options for things that still work; switching is your call.", "");
    for (const u of r.upgrades) out.push(upgradeBlock(u), "");
  }
  const mentioned = r.items.filter((i) => i.section === "mentioned");
  if (mentioned.length) {
    out.push(`## Only in docs and tests (${mentioned.length})`, "", "These don't break the code, but readers and tests still name them.", "");
    for (const i of mentioned) out.push(`- ${i.entry.providerName}: ${i.entry.what} (${when(i)}): ${i.lines.slice(0, 3).map((l) => `\`${l.file}:${l.line}\``).join(", ")}${i.lines.length > 3 ? ` and ${i.lines.length - 3} more` : ""}`);
    out.push("");
  }
  if (r.uncovered.hosts.length || r.uncovered.keyNames.length) {
    out.push("## Outside APIs the radar doesn't cover yet", "", "Not checked yet: YakBarber researches these from each company's own pages next.", "");
    if (r.uncovered.hosts.length) out.push(`- Addresses: ${r.uncovered.hosts.map((h) => `\`${h}\``).join(", ")}`);
    if (r.uncovered.keyNames.length) out.push(`- Key names: ${r.uncovered.keyNames.map((k) => `\`${k}\``).join(", ")}`);
    out.push("");
  }
  out.push(
    "## How this was checked",
    "",
    `- Read: ${r.packages} dependencies, the web addresses in the code and the key names it reads (secret files are never opened).`,
    `- Searched every exact name on the radar. A line counts only for a company the code uses, or when the line names the company${r.unrelated ? ` (${r.unrelated} line${r.unrelated === 1 ? "" : "s"} left out for that reason)` : ""}.`,
    "- Each line is sorted as code, setting, menu or list, docs or test. Names were matched, not run: whether the call around a name still works with today's SDK is checked when a fix is made.",
  );
  return `${out.join("\n")}\n`;
}

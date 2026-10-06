// Whole-code check, part 2: which of the radar's companies does this code use? A company counts when the project
// depends on its SDK, calls one of its addresses, or reads its key. The evidence is kept, so the report can say why.
import type { Inventory } from "./inventory.ts";
import { pypiName } from "./inventory.ts";
import type { RadarData, RadarDataProvider } from "./radar.ts";

/** Lower case, letters and digits only: "Mercado Libre" → "mercadolibre". */
export const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Other names a company goes by in addresses and key names (GEMINI_API_KEY is Google's; graph.facebook.com is Meta's).
const ALIASES: Record<string, string[]> = {
  google: ["gemini", "generativelanguage", "aiplatform", "vertexai"],
  anthropic: ["claude"],
  "aws-bedrock": ["bedrock", "bedrockruntime"],
  meta: ["facebook", "instagram", "whatsapp"],
  huggingface: ["hf", "huggingfacehub"],
  "azure-openai": ["azureopenai", "openaiazure"],
  "mercadolibre-mercadopago": ["mercadopago", "mercadolibre", "mercadolivre", "meli"],
  "paypal-braintree": ["paypal", "braintree", "braintreegateway"],
  "google-maps-platform": ["googlemaps"],
  xai: ["grok"],
  "together-ai": ["together", "togetherai"],
  "fireworks-ai": ["fireworks"],
  "retell-ai": ["retell", "retellai"],
  "microsoft-graph": ["msgraph", "graphmicrosoft"],
};

/** The names one company goes by, compacted: its id, its display name and its aliases. */
export function namesOf(p: Pick<RadarDataProvider, "id" | "name">): string[] {
  return [...new Set([compact(p.id), compact(p.name), ...(ALIASES[p.id] ?? [])])].filter((n) => n.length >= 2);
}

// Addresses whose labels don't name the company the way its id does.
const HOST_RULES: [RegExp, string][] = [
  [/\.openai\.azure\.com$/, "azure-openai"],
  [/(^|\.)bedrock(-runtime|-agent-runtime)?\.[a-z0-9-]+\.amazonaws\.com$/, "aws-bedrock"],
  [/(^|\.)(generativelanguage|aiplatform)\.googleapis\.com$/, "google"],
  [/(^|\.)maps\.googleapis\.com$/, "google-maps-platform"],
  [/(^|\.)googleads\.googleapis\.com$/, "google-ads-api"],
  [/(^|\.)graph\.microsoft\.com$/, "microsoft-graph"],
  [/(^|\.)graph\.facebook\.com$/, "meta"],
  [/(^|\.)x\.ai$/, "xai"],
];

export interface UsedProvider {
  id: string;
  name: string;
  reasons: string[];
}

/** The radar's companies this code uses, with the evidence for each (package, address or key name). */
export function usedProviders(inventory: Inventory, radar: RadarData): UsedProvider[] {
  const used = new Map<string, Set<string>>();
  const add = (id: string, reason: string) => used.set(id, (used.get(id) ?? new Set()).add(reason));

  // SDK packages. A package several companies list (OpenAI's SDK also talks to Azure, DeepSeek and Perplexity)
  // counts for the company it's named after; otherwise for every company that lists it.
  for (const pkg of inventory.packages) {
    if (pkg.ecosystem !== "npm" && pkg.ecosystem !== "pypi") continue;
    const owners = radar.providers.filter((p) => (pkg.ecosystem === "npm" ? p.packages.npm.includes(pkg.name) : p.packages.pypi.map(pypiName).includes(pkg.name)));
    const named = owners.filter((p) => namesOf(p).some((n) => compact(pkg.name).includes(n) && n.length >= 4));
    for (const p of named.length ? named : owners) add(p.id, `${pkg.name} package (${pkg.file})`);
  }

  // Imports: the code loads the SDK even when no dependency file names it (an optional import).
  for (const imp of inventory.imports) {
    const owners = radar.providers.filter(
      (p) =>
        p.packages.npm.includes(imp.value) ||
        p.packages.pypi.some((pkg) => pypiName(pkg) === pypiName(imp.value) || pypiName(pkg).replace(/-/g, "") === compact(imp.value)) ||
        namesOf(p).some((n) => n.length >= 4 && compact(imp.value) === n),
    );
    const named = owners.filter((p) => namesOf(p).some((n) => compact(imp.value).includes(n) && n.length >= 4));
    for (const p of named.length ? named : owners) add(p.id, `imports ${imp.value} (${imp.files[0]})`);
  }

  for (const host of inventory.hosts) {
    const hostname = host.value.split(/[/:?#]/)[0]!;
    const labels = hostname.split(".").map(compact);
    const ruled = HOST_RULES.filter(([re]) => re.test(hostname)).map(([, id]) => id);
    const hits = ruled.length ? ruled : radar.providers.filter((p) => namesOf(p).some((n) => n.length >= 4 && labels.includes(n))).map((p) => p.id);
    for (const id of hits) add(id, `${hostname} (${host.files[0]}${host.files.length > 1 ? ` and ${host.files.length - 1} more` : ""})`);
  }

  for (const key of inventory.keyNames) {
    // Runs of whole words: OPENAI_API_KEY → "openai"; LOW_RISK_OPENAI_API_KEY → … "openai"; AZURE_OPENAI_API_KEY →
    // "azure", "openai", "azureopenai" (the longest company name that fits wins); METABASE_API_KEY → "metabase" (not Meta).
    const words = key.value.replace(/_(API_KEY|API_TOKEN|SECRET_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|APIKEY|KEY)$/, "").split("_");
    const leads = new Set(words.flatMap((_, i) => words.slice(i).map((__, j) => compact(words.slice(i, i + j + 1).join("")))));
    const fits = radar.providers.flatMap((p) => namesOf(p).filter((n) => leads.has(n)).map((n) => ({ p, n })));
    const longest = Math.max(0, ...fits.map((f) => f.n.length));
    for (const { p } of fits.filter((f) => f.n.length === longest)) add(p.id, `${key.value} (${key.files[0]})`);
  }

  return radar.providers.filter((p) => used.has(p.id)).map((p) => ({ id: p.id, name: p.name, reasons: [...used.get(p.id)!] }));
}

/** Addresses that look like an API (api.… or …api…) and don't belong to any company the radar knows: to research. */
export function uncoveredHosts(inventory: Inventory, radar: RadarData): string[] {
  const known = (hostname: string) => {
    const labels = hostname.split(".").map(compact);
    return HOST_RULES.some(([re]) => re.test(hostname)) || radar.providers.some((p) => namesOf(p).some((n) => n.length >= 4 && labels.includes(n)));
  };
  const hosts = inventory.hosts.map((h) => h.value.split(/[/:?#]/)[0]!).filter((h) => /(^|\.)api[.-]|[.-]api\.|^api\d*\./i.test(h) && !known(h));
  return [...new Set(hosts)].sort();
}

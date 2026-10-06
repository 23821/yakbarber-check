// The Retirement Radar's public data (site/radar/radar.json, also https://yakbarber.com/radar/radar.json), as the
// whole-code check reads it. Only the fields the check uses are checked; anything else passes through.
import { readFile } from "node:fs/promises";
import { z } from "zod";

/** A price as numbers (apps/radar CostSchema): per unit, in dollars or the company's credits; tokens have an output price too. */
const CostSchema = z
  .object({ unit: z.string(), currency: z.enum(["usd", "credits"]).default("usd"), price: z.number(), outputPrice: z.number().nullable().default(null) })
  .loose();

/** Something else the same company offers for the job: its own words on what it is for, priced from its own pricing page. */
const AlternativeSchema = z
  .object({
    name: z.string(),
    recommended: z.boolean().default(false),
    says: z.string().nullable().default(null),
    saysUrl: z.string().nullable().default(null),
    price: z.string().nullable().default(null),
    cost: CostSchema.nullable().default(null),
    priceUrl: z.string().nullable().default(null),
    checked: z.string().nullable().default(null),
    retires: z.string().nullable().default(null),
  })
  .loose();

const RadarEntrySchema = z
  .object({
    id: z.string(),
    providerId: z.string(),
    providerName: z.string(),
    category: z.string(),
    what: z.string(),
    identifiers: z.array(z.string()),
    date: z.string(),
    precision: z.enum(["day", "month"]).default("day"),
    dateNote: z.string().nullable().default(null),
    kind: z.string().default("product"),
    /** "migrate-by": the company asks to move by the date without saying the old thing stops working. */
    deadline: z.enum(["switch-off", "migrate-by"]).default("switch-off"),
    replacement: z.string().nullable().default(null),
    sourceUrl: z.string(),
    quote: z.string().default(""),
    impact: z.string().nullable().default(null),
    price: z
      .object({ old: z.string().nullable(), new: z.string().nullable(), change: z.string().nullable(), sourceUrl: z.string(), checked: z.string() })
      .nullable()
      .default(null),
    changeId: z.string().nullable().default(null),
    oldCost: CostSchema.nullable().default(null),
    alternatives: z.array(AlternativeSchema).default([]),
  })
  .loose();

/** A newer option from the same company for something that still works (apps/radar UpgradeSchema). */
const UpgradeSchema = z
  .object({
    from: z.array(z.string()),
    to: z.string(),
    says: z.string(),
    saysUrl: z.string(),
    oldPrice: z.string().nullable().default(null),
    oldCost: CostSchema.nullable().default(null),
    price: z.string().nullable().default(null),
    cost: CostSchema.nullable().default(null),
    priceUrl: z.string().nullable().default(null),
    checked: z.string().nullable().default(null),
  })
  .loose();

const RadarProviderSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    category: z.string(),
    about: z.string().nullable().default(null),
    docsUrl: z.string().nullable().default(null),
    pricingUrl: z.string().nullable().default(null),
    deprecationsPage: z.string().nullable().default(null),
    packages: z.object({ npm: z.array(z.string()).default([]), pypi: z.array(z.string()).default([]) }).default({ npm: [], pypi: [] }),
    upgrades: z.array(UpgradeSchema).default([]),
  })
  .loose();

export const RadarDataSchema = z
  .object({
    checked: z.string(),
    providers: z.array(RadarProviderSchema),
    entries: z.array(RadarEntrySchema),
    earlier: z.array(RadarEntrySchema).default([]),
  })
  .loose();

export type RadarData = z.infer<typeof RadarDataSchema>;
export type RadarDataEntry = z.infer<typeof RadarEntrySchema>;
export type RadarDataProvider = z.infer<typeof RadarProviderSchema>;
export type RadarCost = z.infer<typeof CostSchema>;
export type RadarAlternative = z.infer<typeof AlternativeSchema>;
export type RadarUpgrade = z.infer<typeof UpgradeSchema>;

/**
 * The same name, as a value in code and an identifier on the radar can be written: exact, or the radar's longer form
 * ending in it ("api.mercadolibre.com/items?ids=" for "/items?ids=", "GET /list-agents" for "/list-agents").
 */
export function sameName(identifier: string, value: string): boolean {
  if (identifier === value) return true;
  if (!identifier.endsWith(value)) return false;
  const before = identifier.slice(0, identifier.length - value.length);
  return value.startsWith("/") || /[\s./]$/.test(before);
}

/** Reads the radar's data from a file, or from an https address (the published copy). */
export async function loadRadarData(source: string, fetchImpl: typeof fetch = fetch): Promise<RadarData> {
  let raw: string;
  if (source.startsWith("https://")) {
    const res = await fetchImpl(source);
    if (!res.ok) throw new Error(`Couldn't read the radar from ${source} (HTTP ${res.status})`);
    raw = await res.text();
  } else {
    raw = await readFile(source, "utf8");
  }
  const parsed = RadarDataSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`${source} isn't the radar's data: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

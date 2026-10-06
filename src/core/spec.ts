// Change spec loader: reads changes/*.yaml and validates each file. Invalid specs fail loudly.
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date written as YYYY-MM-DD")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), {
    message: "is not a real calendar date",
  });

const httpsUrl = z.url().refine((u) => /^https:\/\//i.test(u), { message: "must be an https:// link" });
const modelName = z.string().regex(/^[\w.:/-]+$/, "must be a plain model name");

// The provider's models a project can move to, priced, so a pull request can say what the switch costs and
// what else there is. Prices are copied from the provider's own pricing page (prices_from) on `checked`.
const ModelsSchema = z
  .strictObject({
    unit: z.string().min(1), // what one price buys, e.g. "minute of audio"
    currency: z.enum(["usd", "credits"]).default("usd"), // "credits" for providers that bill in their own credits
    prices_from: httpsUrl,
    checked: isoDate,
    compare: httpsUrl.optional(), // the provider's page on choosing between the models
    old: z.strictObject({ name: modelName, price: z.number().nonnegative() }),
    choices: z.array(z.strictObject({ name: modelName, price: z.number().nonnegative(), use_for: z.string().min(1) })).min(1),
  })
  .refine((m) => new Set(m.choices.map((c) => c.name)).size === m.choices.length, { message: "lists the same model twice", path: ["choices"] });

export const ChangeSpecSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes"),
    provider: z.string().min(1),
    provider_name: z.string().min(1).optional(), // how the provider writes its own name, e.g. "DemoPay"
    title: z.string().min(1),
    // What a pull request does, short enough for its title after "fix: ", e.g. "move Cartesia text-to-speech to sonic-3.6".
    pr_subject: z.string().min(1).max(90).optional(),
    // A draft is not confirmed with the provider: scans and dry runs only, never a pull request (assertPublishable).
    draft: z.boolean().default(false),
    announced: isoDate,
    deadline: isoDate.optional(), // only a draft may leave it out (no shutdown date announced yet)
    // What the deadline means, in the provider's own words (the same idea as a radar entry's `deadline`):
    // "switch-off" (the default): the old API stops working on that date.
    // "migrate-by": the provider asks integrations to move by then without saying the old API stops, so no text
    // may say it "breaks" (deadlineKind; outreachIntro, prBody, draftNote).
    deadline_kind: z.enum(["switch-off", "migrate-by"]).optional(),
    severity: z.enum(["breaking", "deprecation", "info"]),
    docs_url: httpsUrl,
    applies_to: z.strictObject({
      languages: z.array(z.string().min(1)).min(1),
    }),
    detect: z
      .strictObject({
        strings: z.array(z.string().min(1)).default([]),
        sdk_calls: z
          .array(
            z.strictObject({
              package: z.string().min(1),
              symbols: z.array(z.string().regex(/^[A-Za-z_$][\w$]*$/, "must be a plain identifier")).min(1),
              // Only calls that leave all of these arguments out are affected (a library default, e.g. ChatOpenAI
              // without `model`): the scan then skips calls naming one, and lines that don't call the symbol.
              unless_args: z.array(z.string().regex(/^[A-Za-z_]\w*$/, "must be a plain argument name")).min(1).optional(),
            }),
          )
          .default([]),
      })
      .refine((d) => d.strings.length + d.sdk_calls.length > 0, {
        message: "needs at least one entry in strings or sdk_calls",
      }),
    // Parts of the change that were already switched off before the deadline. A project that uses one of these
    // strings is broken now, and its pull request says so ("stopped working on June 1") instead of "will break".
    already_off: z.array(z.strictObject({ since: isoDate, strings: z.array(z.string().min(1)).min(1) })).default([]),
    migration: z.strictObject({
      summary: z.string().min(1),
      examples: z
        .array(z.strictObject({ language: z.string().min(1), before: z.string().min(1), after: z.string().min(1) }))
        .default([]),
    }),
    models: ModelsSchema.optional(),
    notes: z.record(z.string(), z.string()).optional(),
  })
  .refine((s) => s.draft || s.deadline !== undefined, { message: "is missing (only a draft spec may leave out the deadline)", path: ["deadline"] })
  .refine((s) => s.deadline === undefined || s.deadline >= s.announced, { message: "deadline is before the announced date", path: ["deadline"] })
  .refine((s) => s.deadline_kind === undefined || s.deadline !== undefined, { message: "says what the deadline means, but there is no deadline", path: ["deadline_kind"] })
  // A deprecation's date is often only a date to migrate by: the spec must say which, so nothing claims "breaks" by default.
  .refine((s) => s.severity !== "deprecation" || s.deadline === undefined || s.deadline_kind !== undefined, {
    message: "is missing: a deprecation with a deadline must say whether the date is a switch-off or a migrate-by date",
    path: ["deadline_kind"],
  })
  .refine((s) => s.already_off.every((o) => o.strings.every((x) => s.detect.strings.includes(x))), {
    message: "lists a string that isn't in detect.strings (the scan must look for everything already switched off)",
    path: ["already_off"],
  });

export type ChangeSpec = z.infer<typeof ChangeSpecSchema>;

export class ChangeSpecError extends Error {
  override name = "ChangeSpecError";
}

/** Parses and validates one change spec. `source` is only used in error messages. */
export function parseChangeSpec(text: string, source: string): ChangeSpec {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ChangeSpecError(`${source}: not valid YAML — ${(err as Error).message}`);
  }
  const result = ChangeSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new ChangeSpecError(`${source}: invalid change spec\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Loads one spec file. The file name must match the spec id: changes/<id>.yaml */
export async function loadChangeSpec(file: string): Promise<ChangeSpec> {
  const spec = parseChangeSpec(await readFile(file, "utf8"), file);
  const expected = basename(file).replace(/\.ya?ml$/, "");
  if (spec.id !== expected) {
    throw new ChangeSpecError(`${file}: id "${spec.id}" does not match the file name (expected id "${expected}")`);
  }
  return spec;
}

/** Loads every spec in a folder. Any invalid spec stops the whole load. */
export async function loadChangeCatalog(dir: string): Promise<ChangeSpec[]> {
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  return Promise.all(files.map((f) => loadChangeSpec(join(dir, f))));
}

export async function findChangeSpec(dir: string, id: string): Promise<ChangeSpec> {
  const catalog = await loadChangeCatalog(dir);
  const spec = catalog.find((s) => s.id === id);
  if (!spec) {
    const known = catalog.map((s) => s.id).join(", ") || "none";
    throw new ChangeSpecError(`No change spec with id "${id}" in ${dir} (known: ${known})`);
  }
  return spec;
}

/** The provider's display name, falling back to its id. */
export function providerName(spec: ChangeSpec): string {
  return spec.provider_name ?? spec.provider;
}

/**
 * Refuses a draft spec. Drafts describe a change the provider hasn't confirmed with us (often with no
 * shutdown date), so they are only used to scan and make dry-run fixes, never to open a pull request.
 */
export function assertPublishable(spec: ChangeSpec): asserts spec is ChangeSpec & { deadline: string } {
  if (spec.draft || spec.deadline === undefined) {
    throw new ChangeSpecError(
      `${spec.id} is a draft change spec (not confirmed with ${providerName(spec)}). It can be used to scan and to make dry-run fixes, but never to open a pull request.`,
    );
  }
}

/**
 * The spec with a project team's choice of replacement model added to the migration instructions
 * (`--use <model>`; later, a reply on the pull request).
 */
export function withChosenModel(spec: ChangeSpec, model: string): ChangeSpec {
  const choice = spec.models?.choices.find((c) => c.name === model);
  if (!choice) {
    const known = spec.models?.choices.map((c) => c.name).join(", ") || "none listed in this change spec";
    throw new ChangeSpecError(`"${model}" isn't one of the models for ${spec.id} (choices: ${known}).`);
  }
  const decision = `This project's team chose ${model} (${choice.use_for}) as the replacement for ${spec.models!.old.name}. Use ${model} everywhere this change applies, instead of the default above. If a call can't use ${model} without changing how the code works, leave that call unchanged with a TODO(yakbarber) that explains why.`;
  return { ...spec, migration: { ...spec.migration, summary: `${spec.migration.summary.trimEnd()}\n\n${decision}\n` } };
}

/** What the deadline means: "migrate-by" only when the spec says so (the provider asks to move by then); otherwise "switch-off". */
export function deadlineKind(spec: ChangeSpec): "switch-off" | "migrate-by" {
  return spec.deadline_kind ?? "switch-off";
}

/** Whole days from `today` until the deadline (negative once it has passed); null when there is none. */
export function daysUntilDeadline(spec: ChangeSpec, today = new Date()): number | null {
  if (spec.deadline === undefined) return null;
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((Date.parse(`${spec.deadline}T00:00:00Z`) - startOfToday) / 86_400_000);
}

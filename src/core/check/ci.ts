// The check in CI (GitHub Actions): an exit code from the report (`--fail-on`), one annotation per line so the
// retiring calls show up in the pull request's Files tab, and the report in the job summary. Everything here is
// printed on the project's own runner; nothing from the code is sent anywhere.
import { posix } from "node:path";
import { deadlineWords, pastMoveBy, type CheckReport, type ReportItem } from "./report.ts";

export const FAIL_ON = ["broken", "soon", "none"] as const;
export type FailOn = (typeof FAIL_ON)[number];

/** Whether the check should fail: `broken` = anything broken now, `soon` = broken now or due in the next 90 days. */
export function failsCheck(report: CheckReport, failOn: FailOn): boolean {
  const sections = failOn === "broken" ? ["broken"] : failOn === "soon" ? ["broken", "soon"] : [];
  return report.items.some((i) => sections.includes(i.section));
}

/** The sentence `--fail-on` prints when it fails, or null when the check passes. */
export function failureLine(report: CheckReport, failOn: FailOn): string | null {
  if (!failsCheck(report, failOn)) return null;
  const count = (s: string) => report.items.filter((i) => i.section === s).length;
  const past = report.items.filter(pastMoveBy).length;
  const due = count("soon") - past;
  const parts = [
    count("broken") && `${count("broken")} broken now`,
    failOn === "soon" && past && `${past} past a date to move by`,
    failOn === "soon" && due && `${due} due in the next 90 days`,
  ].filter(Boolean);
  return `Failing (--fail-on ${failOn}): ${parts.join(", ")}.`;
}

// GitHub shows at most 10 annotations of each kind per step; the report in the job summary has the rest.
const MAX_PER_KIND = 10;
// Workflow commands: `%`, `\r` and `\n` in the message, plus `,` and `:` in a property, must be escaped.
const message = (text: string) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const property = (text: string) => message(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/**
 * GitHub Actions annotations (`::error` for broken now, `::warning` for the next 90 days), one per line, as the
 * check prints them when GITHUB_ACTIONS is set. `prefix` is the checked folder relative to the repository (annotations
 * on a file only show up when its path matches the checkout); with none (a `--repo` clone), the lines are named in
 * the message instead.
 */
export function renderCheckAnnotations(report: CheckReport, prefix: string | null = ""): string[] {
  const out: string[] = [];
  const kinds: [ReportItem["section"], "error" | "warning"][] = [["broken", "error"], ["soon", "warning"]];
  for (const [section, level] of kinds) {
    const lines = report.items.filter((i) => i.section === section).flatMap((item) => item.lines.map((line) => ({ item, line })));
    for (const { item, line } of lines.slice(0, MAX_PER_KIND)) {
      const e = item.entry;
      const what = `${e.providerName}: ${e.what} (${deadlineWords(e, item.days)}). Use instead: ${e.replacement ?? "no direct replacement named"}.`;
      if (prefix === null) out.push(`::${level} title=YakBarber::${message(`${line.file}:${line.line} ${what}`)}`);
      else out.push(`::${level} file=${property(posix.join(prefix, line.file))},line=${line.line},title=YakBarber::${message(what)}`);
    }
    if (lines.length > MAX_PER_KIND) out.push(`::${level} title=YakBarber::${message(`and ${lines.length - MAX_PER_KIND} more line${lines.length - MAX_PER_KIND === 1 ? "" : "s"} ${section === "broken" ? "broken now" : "due in the next 90 days"}: see the job summary.`)}`);
  }
  return out;
}

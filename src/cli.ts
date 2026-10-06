// The public yakbarber command, published on npm (`npx yakbarber check`): the free whole-code check of a project
// against the Retirement Radar. Read-only and local: no Claude, nothing from the project is run or sent anywhere; the
// only network requests are the radar's public data and, with --repo, a read-only clone of a public repository.
// `skill` (skill.ts) is the one command that writes: the coding-agent skill, into the folder it's given.
// The founder's commands (scans, fixes, pull requests, outreach, campaigns) stay in index.ts and are never published.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { styleText } from "node:util";
// Only the check, the read-only clone and the clean-up: the published bundle must not carry Claude, GitHub or Docker code.
import { checkRepo, FAIL_ON, failureLine, loadRadarData, renderCheckAnnotations, renderCheckMarkdown, type FailOn } from "./core/check/index.ts";
import { cleanUpOnInterrupt } from "./core/cleanup.ts";
import { cloneRepo, githubCloneUrl, type Clone } from "./core/github/git.ts";
import { Command } from "commander";
import { SKILL_PATHS, writeSkill } from "./skill.ts";

export const RADAR_URL = "https://yakbarber.com/radar/radar.json";
export const APP_URL = "https://github.com/apps/yakbarber-ai";
declare const YAKBARBER_VERSION: string | undefined; // set by the npm build (scripts/build-npm.ts)
const version = typeof YAKBARBER_VERSION === "string" ? YAKBARBER_VERSION : "dev";

class UserError extends Error {}

export function buildProgram(write: (text: string) => void = (t) => console.log(t)): Command {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const style = (format: Parameters<typeof styleText>[0], text: string) => (useColor ? styleText(format, text) : text);
  const program = new Command()
    .name("yakbarber")
    .description("Finds the outside APIs and models your code uses that are being retired: the date, the company's own words and what to use instead.")
    .version(version);

  program
    .command("check")
    .description("Check a project against the Retirement Radar (free, read-only: nothing from your code leaves this computer)")
    .argument("[folder]", "the project's folder", ".")
    .option("-r, --repo <owner/repo>", "check a public GitHub repository instead (cloned read-only into a temporary folder, deleted after)")
    .option("--radar <file-or-url>", "the radar's data", RADAR_URL)
    .option("--out <file>", "also write the report to this file")
    .option("--json", "print the report as JSON")
    .option("--today <YYYY-MM-DD>", "check as of this day")
    .option("--fail-on <level>", "for CI: exit 1 on 'broken' (something switched off is still used) or 'soon' (also anything due in the next 90 days); 'none' never fails", "none")
    .action(async (folder: string, opts: { repo?: string; radar: string; out?: string; json?: boolean; today?: string; failOn: string }) => {
      if (opts.repo && !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new UserError(`Not a repository name: ${opts.repo} (expected owner/repo)`);
      if (opts.today && !/^\d{4}-\d{2}-\d{2}$/.test(opts.today)) throw new UserError(`--today must be YYYY-MM-DD, not ${opts.today}`);
      if (!(FAIL_ON as readonly string[]).includes(opts.failOn)) throw new UserError(`--fail-on must be broken, soon or none, not ${opts.failOn}`);
      const failOn = opts.failOn as FailOn;
      const radarSource = opts.radar.startsWith("https://") ? opts.radar : resolve(opts.radar);
      const radar = await loadRadarData(radarSource).catch((e: unknown) => {
        throw new UserError(`Couldn't read the Retirement Radar from ${opts.radar}: ${e instanceof Error ? e.message : String(e)}`);
      });
      const today = opts.today ? new Date(`${opts.today}T12:00:00Z`) : new Date();
      let clone: Clone | undefined;
      try {
        let repoDir: string;
        if (opts.repo) {
          const [owner, repo] = opts.repo.split("/") as [string, string];
          if (!opts.json) write(style("dim", `Cloning ${opts.repo} (read-only, deleted after) …`));
          clone = await cloneRepo(githubCloneUrl(owner, repo));
          repoDir = clone.dir;
        } else {
          repoDir = resolve(folder);
          if (!existsSync(repoDir)) throw new UserError(`Folder not found: ${folder}`);
        }
        const repository = opts.repo ?? (folder === "." ? "this folder" : folder);
        if (!opts.json) write(style("dim", `Checking ${repository} against ${radar.entries.length + radar.earlier.length} retirements from ${radar.providers.length} companies …\n`));
        const report = await checkRepo({ repoDir, radar, repository, today });
        const markdown = renderCheckMarkdown(report);
        const text = opts.json ? JSON.stringify(report, null, 2) : markdown;
        if (opts.out) writeFileSync(resolve(opts.out), text);
        write(text);
        if (!opts.json) {
          if (opts.out) write(style("dim", `Saved to ${opts.out}`));
          const toFix = report.items.filter((i) => i.section === "broken" || i.section === "soon" || i.section === "offered").length;
          if (toFix > 0 && !opts.repo) write(style("dim", `\nLet your coding agent fix ${toFix === 1 ? "it" : `these ${toFix}`}: npx yakbarber skill${folder === "." ? "" : ` ${folder}`} (then /yakbarber in Claude Code)`));
          write(style("dim", `\nKeep watching and get tested fix pull requests: ${APP_URL} (free for developers)`));
        }
        // In GitHub Actions: the lines as annotations in the pull request's Files tab, the report in the job summary.
        // Both stay on the project's own runner; nothing is sent to YakBarber. (With --json the output is the JSON alone.)
        if (process.env.GITHUB_ACTIONS) {
          const prefix = clone ? null : relative(process.cwd(), repoDir).split("\\").join("/");
          if (!opts.json) for (const line of renderCheckAnnotations(report, prefix)) write(line);
          if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
        }
        const failure = failureLine(report, failOn);
        if (failure) {
          console.error(failure);
          process.exitCode = 1;
        }
      } finally {
        await clone?.cleanup();
      }
    });

  program
    .command("skill")
    .description(`Save a skill so your coding agent can run the check and fix what it finds (writes ${SKILL_PATHS.join(" and ")})`)
    .argument("[folder]", "the project's folder", ".")
    .option("--force", "replace a skill file someone changed")
    .action((folder: string, opts: { force?: boolean }) => {
      const projectDir = resolve(folder);
      if (!existsSync(projectDir)) throw new UserError(`Folder not found: ${folder}`);
      for (const w of writeSkill(projectDir, opts.force)) {
        write(w.status === "kept" ? `Kept ${w.path}: it was changed (--force replaces it)` : `${w.status === "written" ? "Saved" : "Already up to date:"} ${w.path}`);
      }
      write(style("dim", "\nClaude Code: type /yakbarber. Codex and other agents that read .agents/skills: ask them to use the yakbarber skill."));
    });
  return program;
}

export async function main(argv = process.argv): Promise<void> {
  cleanUpOnInterrupt(); // Ctrl-C removes a temporary clone before exiting
  try {
    await buildProgram().parseAsync(argv);
  } catch (e) {
    if (e instanceof UserError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
}

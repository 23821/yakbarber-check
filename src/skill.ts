// `npx yakbarber skill`: saves a skill into a project so the developer's own coding agent (Claude Code, Codex and others
// that read .agents/skills) runs the free check and moves the code off what is retiring. The check stays read-only; this
// is the only command that writes, and only these two files, after the person asked for it by name.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SKILL_PATHS = [".claude/skills/yakbarber/SKILL.md", ".agents/skills/yakbarber/SKILL.md"] as const;

export const SKILL_TEXT = `---
name: yakbarber
description: Find and fix code that still calls AI models or API endpoints their company is retiring (switched off already or due soon), using the company's own replacement. Use when asked to check for retired, deprecated or sunset models and APIs, or to move off one.
---

# YakBarber: move off retiring models and APIs

1. From the project's root, run the free check (read-only: nothing from the code is sent anywhere):

   \`\`\`sh
   npx --yes yakbarber@latest check
   \`\`\`

   For each retirement it gives the date, the company's own words with a link, **Use instead** (the company's replacement), the price change, and every line in this code as \`file:line\`.

2. Fix these sections, in this order, and nothing else unless the user asks:
   - **Broken now**: these calls fail today.
   - **Due in the next 90 days**.
   - **Offered in a menu or list**: replace or remove the retired option.

   Use the replacement under **Use instead**. If it says "no direct replacement named", pick from the company's options in the report and tell the user which one and why. Open the company's linked page before changing settings: a newer model may not take the same parameters.

3. Change only the retired value and what has to move with it. Where the same value is stated in config, \`.env.example\`, docs or tests, update those too so they match. Never open or edit \`.env\` or other secret files: tell the user which setting to change there.

4. Leave **Only in docs and tests** and **Newer options** alone unless the user asks: they don't break anything.

5. A retirement the report calls "migrate by" is a date the company asks integrations to move by, not a switch-off: say so, and don't call it broken.

6. Run the project's own tests and linters. Then run the check again and confirm the lines you fixed are gone.

7. End with a short summary: what changed (\`file:line\`), the replacement and its price change from the report, and anything left for the user to decide.
`;

export type SkillWrite = { path: string; status: "written" | "unchanged" | "kept" };

/** Writes the skill into `projectDir`. A file someone changed is kept unless `force`. */
export function writeSkill(projectDir: string, force = false): SkillWrite[] {
  return SKILL_PATHS.map((path) => {
    const file = join(projectDir, path);
    if (existsSync(file)) {
      const current = readFileSync(file, "utf8");
      if (current === SKILL_TEXT) return { path, status: "unchanged" };
      if (!force) return { path, status: "kept" };
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SKILL_TEXT);
    return { path, status: "written" };
  });
}

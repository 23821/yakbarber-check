// The whole-code check: everything on the Retirement Radar that one project uses (plan:
// docs/plans/2026-10-01-whole-code-check.md). Read-only and free: no Claude, nothing run from the project.
import { takeInventory } from "./inventory.ts";
import { matchRadar } from "./match.ts";
import { uncoveredHosts, usedProviders } from "./providers.ts";
import type { RadarData } from "./radar.ts";
import { buildCheckReport, type CheckReport } from "./report.ts";
import { findUpgrades } from "./upgrades.ts";

export async function checkRepo({ repoDir, radar, repository = repoDir, today = new Date() }: { repoDir: string; radar: RadarData; repository?: string; today?: Date }): Promise<CheckReport> {
  const inventory = await takeInventory(repoDir);
  const used = usedProviders(inventory, radar);
  const { findings, unrelated } = await matchRadar(repoDir, radar, new Set(used.map((u) => u.id)), inventory.platforms);
  const upgrades = await findUpgrades(repoDir, radar, new Set(used.map((u) => u.id)));
  return buildCheckReport({ repository, radar, inventory, used, findings, unrelated, uncoveredHosts: uncoveredHosts(inventory, radar), upgrades, today });
}

export { importedModule, parseDependencyFile, takeInventory, type Inventory, type PackageUse } from "./inventory.ts";
export { matchRadar, needsCompanyNamed, searchable, type Finding } from "./match.ts";
export { uncoveredHosts, usedProviders, type UsedProvider } from "./providers.ts";
export { loadRadarData, RadarDataSchema, sameName, type RadarAlternative, type RadarCost, type RadarData, type RadarDataEntry, type RadarUpgrade } from "./radar.ts";
export { buildCheckReport, costChange, deadlineWords, renderCheckMarkdown, type CheckReport, type ReportItem, type Section } from "./report.ts";
export { findUpgrades, type UpgradeItem } from "./upgrades.ts";
export { findModelUses, type CatalogueModel, type ModelUse } from "./models.ts";

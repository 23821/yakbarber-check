// Builds dist/yakbarber.mjs, the single file published on npm as `yakbarber`.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
await build({
  entryPoints: ["src/bin.ts"],
  outfile: "dist/yakbarber.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  external: ["@vscode/ripgrep"],
  define: { YAKBARBER_VERSION: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as __yakbarberRequire } from "node:module";\nconst require = __yakbarberRequire(import.meta.url);' },
  logLevel: "warning",
});
console.log("Built dist/yakbarber.mjs");

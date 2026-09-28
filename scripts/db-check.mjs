import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Compare bytes, including new/untracked files. This also works in source archives
// without Git metadata and detects changes even if migrations were already dirty.
function migrationFiles(directory = "migrations") {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? migrationFiles(path) : [[path, readFileSync(path).toString("base64")]];
    });
}
const before = JSON.stringify(migrationFiles());
const result = spawnSync("npm", ["run", "db:generate"], { stdio: "inherit", shell: process.platform === "win32" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (JSON.stringify(migrationFiles()) !== before) {
  console.error("Schema drift: drizzle-kit changed migrations/. Review and commit the generated migration and snapshot.");
  process.exit(1);
}
console.log("Schema and migrations agree.");

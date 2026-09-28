import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 0001 explicitly leaves subagents.md to the product owner. Work items contain
// the original templates/specifications and are also outside this check.
const placeholder = /projectname|- guidance|- description|- details|\[[a-z]+ [|]/;
const matches = [];
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "work-items") scan(path); }
    else if (path.endsWith(".md") && path !== join("aspec", "devops", "subagents.md")) {
      readFileSync(path, "utf8").split("\n").forEach((line, index) => {
        if (placeholder.test(line)) matches.push(`${path}:${index + 1}:${line}`);
      });
    }
  }
}
scan("aspec");
if (matches.length) {
  console.error(matches.join("\n"));
  process.exitCode = 1;
} else console.log("No aspec placeholders in scope (work-items and owner-managed subagents.md excluded).");

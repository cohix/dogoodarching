import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

/** Hash the final on-disk shell, after Vite writes HTML and copies public assets. */
export function serviceWorkerCache() {
  let root;
  let outDir;
  return {
    name: "dga-service-worker-cache",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = resolve(root, config.build.outDir);
    },
    async closeBundle() {
      const source = await readFile(resolve(root, "sw.js"), "utf8");
      if (!source.includes("__BUILD_HASH__")) throw new Error("sw.js must contain __BUILD_HASH__");
      const hash = createHash("sha256");
      const add = (name, contents) => {
        hash.update(JSON.stringify([name, contents.length]));
        hash.update(contents);
      };
      async function visit(directory) {
        const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const file = resolve(directory, entry.name);
          if (entry.isDirectory()) await visit(file);
          else if (file !== resolve(outDir, "sw.js")) add(relative(outDir, file), await readFile(file));
        }
      }
      await visit(outDir);
      add("service-worker-source", Buffer.from(source));
      await writeFile(resolve(outDir, "sw.js"), source.replaceAll("__BUILD_HASH__", hash.digest("hex").slice(0, 12)));
    },
  };
}

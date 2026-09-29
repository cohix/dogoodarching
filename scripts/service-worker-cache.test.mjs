import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { build } from "vite";
import { expect, it } from "vitest";
import { serviceWorkerCache } from "./service-worker-cache.mjs";

it("copies the static security policy unchanged with the real Vite config", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "dga-headers-"));
  try {
    await build({ configFile: "frontend/vite.config.ts", logLevel: "silent", build: { outDir } });
    const policy = await readFile(new URL("../frontend/public/_headers", import.meta.url), "utf8");
    expect(await readFile(join(outDir, "_headers"), "utf8")).toBe(policy);
    expect(policy).toContain("/*\n");
    expect(policy).toContain("default-src 'self'");
    expect(policy).not.toContain("unsafe-eval");
    const html = await readFile(join(outDir, "index.html"), "utf8");
    // Production scripts and stylesheets are external same-origin assets.
    for (const tag of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      expect(tag[0]).toMatch(/src="\/assets\//);
      expect(tag[1].trim()).toBe("");
    }
    expect(html).not.toContain("<style");
    expect(await readFile(join(outDir, "sw.js"), "utf8")).not.toContain("__BUILD_HASH__");
  } finally { await rm(outDir, { recursive: true, force: true }); }
}, 30_000);

it("changes cache identity for JS, CSS, HTML, public manifest/icon and SW-only changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dga-shell-"));
  try {
    await mkdir(join(root, "public/icons"), { recursive: true });
    const originals = {
      "index.html": '<html><head></head><body><script type="module" src="/main.js"></script></body></html>',
      "main.js": 'import "./style.css"; console.log("baseline");',
      "style.css": "body { color: red; }",
      "public/manifest.webmanifest": '{"name":"Do Good Arching"}',
      "public/icons/icon.png": "icon bytes",
      "sw.js": 'const CACHE_NAME = "dga-shell-__BUILD_HASH__";',
    };
    for (const [file, contents] of Object.entries(originals)) await writeFile(join(root, file), contents);
    const run = async () => {
      await build({ root, configFile: false, logLevel: "silent", plugins: [serviceWorkerCache()], build: { outDir: "dist" } });
      const sw = await readFile(join(root, "dist/sw.js"), "utf8");
      expect(sw).not.toContain("__BUILD_HASH__");
      return sw.match(/dga-shell-[a-f0-9]{12}/)[0];
    };
    const baseline = await run();
    expect(await run()).toBe(baseline);
    const changes = {
      "main.js": '\nconsole.log("changed");', "style.css": "\nbody { color: blue; }",
      "index.html": "\n<!-- changed HTML -->", "public/manifest.webmanifest": "\n",
      "public/icons/icon.png": "changed bytes", "sw.js": "\n// new service worker behavior",
    };
    for (const [file, suffix] of Object.entries(changes)) {
      await writeFile(join(root, file), originals[file] + suffix);
      expect(await run(), file).not.toBe(baseline);
      await writeFile(join(root, file), originals[file]);
    }
    expect(await run()).toBe(baseline);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("activates over legacy caches and leaves every API request on the network", async () => {
  const source = await readFile(new URL("../frontend/sw.js", import.meta.url), "utf8");
  const handlers = {};
  const removed = [];
  let claimed = false;
  let wait;
  vm.runInNewContext(source, {
    URL,
    self: { location: { origin: "https://dga.test" }, addEventListener: (name, fn) => { handlers[name] = fn; }, clients: { claim: () => { claimed = true; } } },
    caches: { keys: async () => ["dga-shell-v1", "dga-shell-old", "dga-shell-__BUILD_HASH__"], delete: async key => { removed.push(key); } },
    fetch: () => { throw Error("Unexpected intercepted request"); },
  });
  handlers.activate({ waitUntil: promise => { wait = promise; } });
  await wait;
  expect(removed).toEqual(["dga-shell-v1", "dga-shell-old"]);
  expect(claimed).toBe(true);
  for (const [url, method] of [["https://dga.test/api/tracker", "GET"], ["https://dga.test/api/plan/attachments/7/file", "GET"], ["https://dga.test/api/sessions", "POST"], ["https://external.test/assets/test.js", "GET"]]) {
    let intercepted = false;
    handlers.fetch({ request: { url, method }, respondWith: () => { intercepted = true; } });
    expect(intercepted).toBe(false);
  }
});

it("serves invite navigation shells without redirecting or caching token URLs, online and offline", async () => {
  const source = await readFile(new URL("../frontend/sw.js", import.meta.url), "utf8");
  const handlers = {};
  const cacheKeys = [];
  let offline = false;
  let fetched;
  const shell = new Response("app shell");
  vm.runInNewContext(source, {
    URL,
    self: { location: { origin: "https://dga.test" }, addEventListener: (name, fn) => { handlers[name] = fn; } },
    caches: {
      open: async () => ({ put: async (key) => { cacheKeys.push(key); } }),
      match: async key => { expect(key).toBe("/index.html"); return shell; },
    },
    fetch: async request => { fetched = request; if (offline) throw Error("offline"); return shell; },
  });
  // Fragments aren't sent in network requests. They remain in the window URL;
  // the service worker forwards each request as-is and never redirects clients.
  for (const path of ["/invite", "/invite/legacy-token"]) {
    for (const isOffline of [false, true]) {
      offline = isOffline;
      const request = { url: `https://dga.test${path}`, method: "GET", mode: "navigate" };
      let result;
      handlers.fetch({ request, respondWith: promise => { result = promise; } });
      expect(await result).toBe(shell);
      expect(fetched).toBe(request);
    }
  }
  expect(cacheKeys).toEqual(["/index.html", "/index.html"]);
});

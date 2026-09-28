import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Repo root as a filesystem path (works without Node types; same trick as
// frontend/vite.config.ts).
const repoRoot = decodeURIComponent(new URL(".", import.meta.url).pathname);

// Two projects:
//   worker   – integration tests that run inside workerd via
//              @cloudflare/vitest-plugin with real D1 (`DB`) and R2
//              (`ATTACHMENTS`) bindings read from wrangler.toml. Storage is
//              local and in-memory; no Cloudflare login is needed.
//   frontend – React/unit tests for the SPA under jsdom.
// Run one with `npm run test:worker` / `npm run test:frontend`.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "build", environment: "node", include: ["scripts/**/*.test.mjs"] } },
      {
        plugins: [
          // The plugin's options function is the harness's global setup: it
          // runs once, in Node, before any Worker starts. That is the only
          // place `readD1Migrations` can run (it reads the filesystem, which
          // workerd cannot). The migrations are passed to the Worker as the
          // test-only `TEST_MIGRATIONS` binding and applied per test file by
          // test/worker/setup.ts.
          cloudflareTest(async () => {
            const migrations = await readD1Migrations(`${repoRoot}migrations`);
            return {
              wrangler: { configPath: `${repoRoot}wrangler.toml` },
              miniflare: {
                bindings: { TEST_MIGRATIONS: migrations },
              },
            };
          }),
        ],
        test: {
          name: "worker",
          root: repoRoot,
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["test/worker/setup.ts"],
          // PBKDF2 at 210k iterations runs on every bootstrap/login/accept;
          // keep headroom for slow CI runners.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "frontend",
          root: repoRoot,
          environment: "jsdom",
          include: ["frontend/src/**/*.test.{ts,tsx}", "test/frontend/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { serviceWorkerCache } from "../scripts/service-worker-cache.mjs";

// Directory containing this config file (works without node types).
const root = decodeURIComponent(new URL(".", import.meta.url).pathname);

// Run from this directory (`frontend/`) or from the repo root with
// `--config frontend/vite.config.ts`. Builds the static SPA into
// `../dist/client` (`dist/client` at the repo root) for the Worker to serve.
export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), serviceWorkerCache()],
  server: {
    // Preserve the browser's Host and Origin so the Worker compares the same
    // origin during local development (Vite :5173 -> wrangler :8787).
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } },
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});

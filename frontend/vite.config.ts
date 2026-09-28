import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Directory containing this config file (works without node types).
const root = decodeURIComponent(new URL(".", import.meta.url).pathname);

// Run from this directory (`frontend/`) or from the repo root with
// `--config frontend/vite.config.ts`. Builds the static SPA into
// `../dist/client` (repo: `do-good-arching/dist/client`) for the Worker to serve.
export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});

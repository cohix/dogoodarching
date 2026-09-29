# Local Development

Development: local, with `Dockerfile.dev` available as a Debian/Node 22 tooling environment.  
Build tools: npm. The supported Node versions are in the [README prerequisites](../../README.md#quick-start).

## Workflows:

Developer Loop:

1. Follow [README prerequisites and quick start](../../README.md#quick-start), install dependencies and run `npx wrangler login`. `wrangler dev` needs Cloudflare authentication even though application storage is local.
2. Run `npm run db:migrate:local` against the local D1 database.
3. Run `npm run build && npm run dev` to serve Worker and SPA at `http://localhost:8787`; rebuild when frontend source changes.
4. Run the Worker on :8787 alongside `npm run dev:client` on :5173. Vite proxies `/api` to `http://127.0.0.1:8787` with `changeOrigin: false`, preserving Host and browser Origin for the same-origin check. The Vite process alone does not supply backend services.

Local testing:

- Run `npm test`, or select `npm run test:worker` / `npm run test:frontend`; these do not require Cloudflare login. Run `npm run typecheck`, `npm run lint`, `npm run docs:check` and `npm run db:check` before submission. Harness details live in [CI/CD](cicd.md#pipelines).
- Inspect local D1 with `sqlite3` on its SQLite file under `.wrangler/state` (locate it with `find .wrangler/state -name '*.sqlite'`). The development image includes sqlite3.
- Local workerd does not establish hosted-runtime compatibility. Password verification enforces the same supported count range locally and remotely; 210k hashes require the [operator reset](operations.md#admin-runbook). Hosted verification remains required.
- Wrangler simulates configured Rate Limiting bindings locally. Vitest explicitly sets `RATE_LIMIT_MODE: "allow"`; supported mocks are `allow`, `deny`, `deny:<key prefix>` and `error`. Restore `allow` after a test override. Hand-built bindings exercise operation selection. Unknown modes, absent bindings and errors fail closed; never deploy mock modes.
- Unsafe local API requests still need an exact Origin or absent-Origin plus `Sec-Fetch-Site: same-origin`; JSON calls also need application/json. The Worker test `api()` helper defaults the test origin; `origin: null` removes it. Browser application code must let the browser supply Origin and upload Content-Length. See [CSRF](../architecture/security.md#api-security).
- Exercise cron/size backfill via the [local scheduled trigger](operations.md#scheduled-cleanup-jobs).

Version control:

- Branch off `main` and submit changes through the CI checks; [CI/CD](cicd.md#pipelines) defines release identifiers and deployment.
- `.gitignore` excludes `node_modules/`, `dist/`, `.wrangler/`, `.dev.vars`, `.dev.vars.*`, `.DS_Store` and `*.log`. Never commit `.wrangler/`: it contains local data, including password hashes.
- Keep schema changes and generated migration metadata together; follow [migration operations](operations.md#ongoing-operations).

Documentation:

- The [README](../../README.md) is the user-facing quick start; [aspec foundation](../foundation.md) is the design-reference entry point. Numbered work items live in `aspec/work-items/`.
- Update the relevant design document alongside behavioral changes. Import limits/mapping, streaming upload metadata and credential fencing are current behavior documented in security and transfer design.

# Local Development

Development: local, with `Dockerfile.dev` available as a Debian/Node 22 tooling environment.  
Build tools: npm. The supported Node versions are in the [README prerequisites](../../README.md#quick-start).

## Workflows:

Developer Loop:

1. Follow [README prerequisites and quick start](../../README.md#quick-start), install dependencies and run `npx wrangler login`. `wrangler dev` needs Cloudflare authentication even though application storage is local.
2. Run `npm run db:migrate:local` against the local D1 database.
3. Run `npm run build && npm run dev` to serve Worker and SPA at `http://localhost:8787`; rebuild when frontend source changes.
4. Use `npm run dev:client` for Vite frontend-only work. There is no API proxy configured in `frontend/vite.config.ts`; this command alone does not provide the Worker-backed account/tracker flows.

Local testing:

- Run `npm test`, or select `npm run test:worker` / `npm run test:frontend`; these do not require Cloudflare login. Run `npm run typecheck`, `npm run lint` and `npm run db:check` before submission. Harness details live in [CI/CD](cicd.md#pipelines).
- Inspect local D1 with `sqlite3` on its SQLite file under `.wrangler/state` (locate it with `find .wrangler/state -name '*.sqlite'`). The development image includes sqlite3.
- Local workerd does not enforce all hosted limits, particularly the PBKDF2 cap. Passing local auth tests is not evidence of hosted login working; see [security](../architecture/security.md#api-security).

Version control:

- Branch off `main` and submit changes through the CI checks; [CI/CD](cicd.md#pipelines) defines release identifiers and deployment.
- `.gitignore` excludes `node_modules/`, `dist/`, `.wrangler/`, `.dev.vars`, `.dev.vars.*`, `.DS_Store` and `*.log`. Never commit `.wrangler/`: it contains local data, including password hashes.
- Keep schema changes and generated migration metadata together; follow [migration operations](operations.md#ongoing-operations).

Documentation:

- The [README](../../README.md) is the user-facing quick start; [aspec foundation](../foundation.md) is the design-reference entry point. Numbered work items live in `aspec/work-items/`.
- Update the relevant design document alongside behavioral changes. Work item 0002 must turn its planned notes into current behavior when implemented.

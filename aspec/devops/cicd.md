# Continuous Integration and Deployment

Platform: github

## Pipelines:

Build:

- `.github/workflows/ci.yml` runs on every push and pull request using Node 22: `npm ci`, `npm run typecheck`, `npm run lint`, `npm run docs:check`, `npm run db:check`, `npm test`, then `npm run build`.
- Build runs typecheck and `vite build --config frontend/vite.config.ts`, emitting the SPA and hashed-cache service worker into `dist/client`. ESLint's restricted-syntax rule forbids `.transaction()` calls.

Test:

- Vitest's `worker` project runs integration tests inside workerd with local D1 and R2. The installed package is `@cloudflare/vitest-plugin` (the successor used by this repo to the work item's `vitest-pool-workers` name). Migrations apply per test file; setup wipes application rows and R2 between tests.
- The `frontend` project runs React/unit tests under jsdom. [README verification status](../../README.md#verification-status) records the areas currently covered and verification limits, without a fixed test count.
- The `build` test project builds temporary shells to check cache changes for JS/CSS, HTML, manifest/icons and service-worker source, and checks legacy cache cleanup and API bypass.
- `npm run docs:check` rejects placeholders in the in-scope aspec. It excludes work items and the explicitly owner-managed `aspec/devops/subagents.md`; the literal 0001 grep still reports that excluded file’s two template lines.
- `npm run db:check` invokes drizzle-kit generation and compares every migration/snapshot file's bytes before and after. A new/changed file fails the check. Migration tests also replay an empty and a seeded legacy database.

Releases:

- Work from trunk `main`. The preview workflow checks each push to `main` (including merged PRs) before deploying. Deploys are serialized within each environment and are not cancelled mid-flight.

Versioning:

- A release is identified by its resolved git commit SHA, used as the Worker version tag and in its version message. `package.json` version is not a release identifier and is not bumped for this workflow.

Publishing:

- Not applicable: the private application is not published to a package registry.

Deployment:

- `.github/workflows/deploy-preview.yml` runs the same checks on a push to `main`; its `preview` environment job installs/builds, applies remote preview migrations, then deploys with `wrangler deploy --env preview --tag <SHA>`.
- `.github/workflows/deploy-production.yml` is `workflow_dispatch`. Input `sha` selects a commit; empty means the current tip of `main`. The resolve job pins its full SHA, and both checks and deploy jobs check out that same commit. After checks, the `production` environment job installs/builds, migrates production, then deploys tagged with that SHA.
- **Required setup:** configure the `production` GitHub environment's required reviewers. The YAML names the environment but cannot enforce its reviewer settings by itself. Workflow credentials and scopes are listed in [operations](operations.md#installing-and-running).
- Both workflows migrate before deploying. Direct npm deploy scripts only build/deploy; operators must run migrations separately. See [environment commands](operations.md#environments). Real account deployment/approval behavior still requires hosted verification.

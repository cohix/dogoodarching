# Do Good Arching

A multi-user archery training tracker for **athletes** and **coaches**, built on the
native Cloudflare stack: **Workers** + **D1** (via Drizzle ORM) + **R2**, with a React
single-page app served from the same Worker. Installable as a PWA on iOS and Android.

One deployment is one shared team. Every coach can view and edit every athlete's
**plans** and view **weekly/cycle summaries**, while individual log entries
(sessions, scores, notes) stay private. The first coach is the **owner** and can
invite other coaches.

This README is the quick start. The [aspec design reference](aspec/foundation.md)
describes architecture, permissions, UX and operations.

> **Hosted authentication is still blocked until work item 0002:** the current
> password hash uses 210,000 PBKDF2 iterations, above hosted Workers' 100,000 limit.
> Local tests can pass while hosted bootstrap, invite acceptance and login fail.
> See the [current security model and planned fix](aspec/architecture/security.md#api-security).

## Stack

- Runtime: Cloudflare Workers (TypeScript, no Node-only dependencies)
- API: [Hono](https://hono.dev), validation with [Zod](https://zod.dev)
- Database: Cloudflare D1, accessed via [Drizzle ORM](https://orm.drizzle.team)
- File attachments: Cloudflare R2
- Frontend: React 19 + Tailwind CSS v4 + TanStack Query + Recharts, built with Vite
  and served from the Worker via Workers Static Assets (SPA fallback)
- Auth: username + password (WebCrypto PBKDF2), sessions in D1, `httpOnly` cookie

## Prerequisites

- Node.js 22.14+ on the 22.x LTS line, or Node.js 24+; npm
- A Cloudflare account (`npx wrangler login`)

## Quick start

```bash
npm install
npx wrangler login
```

### 1. Create the D1 database

```bash
npx wrangler d1 create do-good-arching
```

Copy the returned `database_id` into `wrangler.toml` (replacing
`REPLACE_WITH_YOUR_D1_DATABASE_ID`).

> **The repository ships with a placeholder `database_id`.** `wrangler.toml`
> is committed with `database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"` (and a
> matching placeholder under `[env.preview]`) because the ID is specific to
> your Cloudflare account. Local development and the test suite work with the
> placeholder, but `npm run deploy`, `npm run deploy:preview` and the remote
> migration commands fail against it with a D1 "database not found" error until
> you replace it with the ID from `wrangler d1 create`.

### 2. Create the R2 bucket (plan attachments: documents/photos)

```bash
npx wrangler r2 bucket create do-good-arching-attachments
```

### 3. Apply migrations

```bash
npm run db:migrate:local   # local dev database
npm run db:migrate:preview # preview (remote) database, see "Environments"
npm run db:migrate         # production (remote) database
```

Migrations live in `migrations/`. A fresh database has no seeded accounts; upgrades
also migrate existing data. Generate changes from `src/db/schema.ts` with
`npm run db:generate`; run `npm run db:check` to check for schema drift. Follow the
[migration and backup procedure](aspec/devops/operations.md#ongoing-operations).

### 4. Local development

```bash
npm run build   # typecheck + build the frontend into dist/client
npm run dev     # wrangler dev -> http://localhost:8787 with local D1 + R2
```

On the first run against a fresh database, run the migrations first
(`npm run db:migrate:local`).

### 5. Deploy

```bash
npm run deploy:preview   # builds, then `wrangler deploy --env preview`
npm run deploy           # builds, then `wrangler deploy` (production)
```

One Worker serves both the API and the app. These deploy scripts build and deploy;
run the matching migrations first. Routine releases use the workflows below.

### Environments

`wrangler.toml` defines two environments, each with its own Worker, D1 database
and R2 bucket:

| | Worker | D1 | R2 | Deployed by |
|---|---|---|---|---|
| **production** (top-level config) | `do-good-arching` | `do-good-arching` | `do-good-arching-attachments` | manual `Deploy production` workflow (approval required) |
| **preview** (`[env.preview]`) | `do-good-arching-preview` | `do-good-arching-preview` | `do-good-arching-attachments-preview` | automatically on every push to `main` |

Create the preview D1 database and R2 bucket the same way as in steps 1–2
(`npx wrangler d1 create do-good-arching-preview`,
`npx wrangler r2 bucket create do-good-arching-attachments-preview`) and paste
the preview `database_id` into `[[env.preview.d1_databases]]`.

Releases are trunk-based: the git commit SHA identifies a deploy (it is set as
the Worker version tag), and the `package.json` version is not used. The
GitHub workflows in `.github/workflows/` need `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` as secrets on the `preview` and `production` GitHub
environments; the required token scopes are documented at the top of each
workflow file.

`CI` runs on every push/PR: install, typecheck, lint, schema drift check, tests and
build. `Deploy preview` repeats these checks on pushes to `main`, then migrates
preview before deploying. `Deploy production` is manually triggered with a
`sha` input (empty means current `main`), checks that commit, then migrates and
deploys it. **Configure required reviewers on the GitHub `production`
environment**; naming the environment in YAML does not configure approval. See
[CI/CD](aspec/devops/cicd.md) and [CI secrets](aspec/devops/operations.md#installing-and-running).

### Tests and lint

```bash
npm test              # both projects: Worker integration tests + frontend unit tests
npm run test:worker   # Worker tests only (run inside workerd with local D1 + R2, migrations applied)
npm run test:frontend # frontend unit tests only (jsdom)
npm run lint          # ESLint (typescript-eslint); also forbids D1-unsupported `.transaction()`
npm run typecheck     # Worker, frontend and test tsconfigs
npm run db:check      # drizzle-kit must produce no migration/snapshot changes
```

Worker tests live in `test/worker/*.test.ts` and use the helpers in
`test/worker/helpers.ts`; frontend tests live next to the code as
`frontend/src/**/*.test.{ts,tsx}` or under `test/frontend/`. No Cloudflare login
is needed to run them.

## First run: accounts, roles, invites

There is no pre-seeded admin. The flow is:

1. Open the app. With zero users you'll see **"Create coach account"**. Choose a
   username and password to create the first coach, who becomes the **owner**.
2. In **Team**, the owner can choose **Invite coach** or **Invite athlete**. Any
   invited coach can also invite athletes. Copy the generated link, such as
   `https://your-app.workers.dev/invite/<token>`, and share it out of band.
   Invitations are single-use and expire after 24 hours; there is no email service.
3. The recipient opens the link, chooses a username/password and joins the shared
   team with the invited role. Every coach sees the same athlete roster.
4. A new athlete starts at cycle 1/week 1 with an editable starter weekly plan.
   Today asks for bow poundage before showing the poundage-dependent next milestone.

Team also lists pending invites with Revoke. The owner manages all invites and
sees the coach roster; other coaches manage their own invites. Athlete invites
remain valid if the creating coach is deleted; coach invites require their
creator to remain owner when accepted.

### Roles & permissions (enforced server-side on every endpoint)

| Capability | Athlete | Coach | Owner (first coach) |
|---|---|---|---|
| Own training data and export/import | Full access | Full access | Full access |
| Athlete plans, schedule and attachments | Own only | View/edit all athletes | View/edit all athletes |
| Athlete weekly/cycle summaries | Own only | View all athletes | View all athletes |
| Other users' individual logs, scores, notes, gear, maintenance | No access | No access | No access |
| Invite athletes | No | Yes | Yes |
| Invite coaches / list coaches | No | No | Yes |
| List/revoke invites | No | Own invites | All invites |
| Download plan files | Own files | Any plan file | Any plan file |

See [personas and detailed RBAC](aspec/foundation.md#personas). There is no
ownership transfer, athlete deactivation or account deletion yet.
**Planned (work item 0002):** these controls and password/session management,
with [lifecycle rules](aspec/uxui/experience.md#signup-and-account). Forgotten
passwords currently require the [manual admin reset procedure](aspec/devops/operations.md#admin-runbook).

## Data export / import

Both roles get **Settings → Export my data**: a single JSON download
(`dga-export-YYYYMMDD.json`) containing the account's full training data, and a
matching **Import** that replaces the account's data after validation. Export is
strictly per-account — there is no cross-user export.

Limitation: uploaded document/photo attachments live in R2 and are **not**
included in the JSON export (link attachments are). Re-upload files after an
import if needed.

## PWA: install on your phone

The app ships a web manifest, iOS meta tags, and a lightweight service worker,
so athletes and coaches can add it to their home screens:

- **iOS (Safari):** open the app → Share → **Add to Home Screen**.
- **Android (Chrome):** open the app → menu → **Add to Home screen** (or Install).

The service worker caches only the static app shell for fast loads; **all
`/api/*` requests bypass its cache** — the cloud database is the source
of truth. There is no offline data sync in v1.

## Project structure

```text
src/
  index.ts            Worker entry and Hono router
  db/                 D1 client, Env bindings and schema.ts (schema source of truth)
  lib/                auth, RBAC, rate limits, shared validation, dates and HTTP helpers
  routes/             thin auth, tracker, coach and transfer handlers
  services/           auth/team, plan/dashboard, sessions/scores, maintenance,
                      setups, inspiration, attachments and import/export
migrations/           reviewed SQL migrations and drizzle-kit metadata
scripts/db-check.mjs  schema/migration no-diff check
frontend/
  index.html          SPA shell and PWA meta tags
  sw.js               shell-cache source; Vite injects a build hash into the emitted sw.js
  public/             manifest and PWA icons
  src/
    App.tsx           auth/query gates and tab shell
    api.ts            typed API client
    features/         auth, dashboard, log, plan, gear, fuel, team and settings
    components/       shared UI, navigation and SafeLink
    lib/              client date/format/mutation helpers
    theme.css         Tailwind v4 theme
test/                Worker integration and frontend harness tests
.github/workflows/    CI, automatic preview and manual production deploys
aspec/                design reference and numbered work items
```

Component responsibilities and data ownership are in the
[architecture reference](aspec/architecture/design.md#major-components).

## API overview

Endpoints are under `/api/*` and require a session cookie except those marked
public. Bodies are JSON; file downloads return bytes. See [API conventions](aspec/architecture/apis.md)
for validation, error statuses and response formats.

- Auth: `GET /api/auth/status` (public), `POST /api/auth/bootstrap` (public,
  first user), `POST /api/auth/login` (public), `POST /api/auth/accept-invite`
  (public), `POST /api/auth/logout`, `GET /api/auth/me`.
- Invitations: `POST/GET /api/auth/invites` and `DELETE /api/auth/invites/:id`
  (coach; creating a coach invite requires the owner).
- Tracker/log: `GET /api/tracker?today=YYYY-MM-DD&before=YYYY-MM-DD,id`
  (optional date/history cursor), `POST /api/sessions`,
  `PUT/DELETE /api/sessions/:id`, `POST /api/scores`,
  `DELETE /api/scores/:id`, `POST /api/notes/weekly`.
- Personal plans: `POST /api/plan/sessions`, `POST /api/plan/weeks`,
  `POST /api/plan/adjust`, `POST /api/plan/poundage`,
  `POST /api/plan/sessions/links`, `POST /api/plan/sessions/files`,
  `DELETE /api/plan/attachments/:id`, `GET /api/plan/attachments/:id/file`.
- Gear/checks: `POST /api/checks`, `POST /api/maintenance/items`,
  `PUT/DELETE /api/maintenance/items/:id`,
  `POST /api/maintenance/items/:id/check`, `POST /api/maintenance/sections/clear`,
  `POST /api/setups`, `POST /api/setups/:id/duplicate`, `POST /api/inspiration`.
- Team: `GET /api/coach/athletes`, `GET /api/coach/coaches` (owner only),
  `GET /api/coach/athletes/:athleteId/overview`.
- Coach plan editing under `/api/coach/athletes/:athleteId`:
  `PUT /plan/sessions`, `PUT /plan/weeks`, `POST /plan/adjust`,
  `POST /plan/sessions/links`, `POST /plan/sessions/files`,
  `DELETE /plan/attachments/:attachmentId`.
- Transfer: `GET /api/export`, `POST /api/import`.

## Notes

- No Worker secrets are required. Authentication and deferred security work are
  documented in [security](aspec/architecture/security.md).
- The service worker uses a content-derived cache name on each changed build and
  deletes old caches on activation, including the legacy `dga-shell-v1` cache.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Verification status

- The Vitest harness runs Worker integration tests in workerd with migrated D1
  and R2, plus frontend tests in jsdom; no Cloudflare login is required.
- Existing Worker tests cover bootstrap/login/logout, cookie/session behavior,
  concurrent account/invite creation, invite expiry/reuse/conflicts, owner-only
  coach invites, deployment-wide team access, coach RBAC and response privacy,
  attachment access, atomic score writes, maintenance section clearing/concurrent
  ordering, missing-row mutation responses, cursor pagination, new-athlete
  defaults and poundage persistence.
- Migration tests exercise empty and populated legacy schemas, foreign keys and
  cascades, owner/inviter conversion, orphan cleanup and program-state backfill.
  `npm run db:check` checks generated-schema drift separately.
- Frontend tests exercise safe attachment links, uploaded-file Open links,
  history pagination and refresh races, 404/double-delete recovery, owner/coach
  invite controls, signup copy and the unset-poundage save flow.
- Worker regressions cover atomic rate-limit bursts, expiry during D1 submission,
  shared-millisecond invite claims, local-calendar defaults, ISO week boundaries,
  realistic multi-chunk imports and D1 rollback on a later import failure.
- The performance smoke compares 100 sessions/100 scores with 5,000 sessions/
  1,000 scores (10,000 ends). It checks constant query count, bounded rows,
  ranged SQL aggregates, selected score IDs and a warmed timing tolerance.
  It does not assert constant database work as history grows.
- Build tests check cache identity for JS/CSS, HTML, public files and service-worker
  changes, plus legacy-cache cleanup and network-only API behavior.
- `npm run docs:check` checks aspec placeholders within this work item's scope;
  owner-managed `aspec/devops/subagents.md` and work items are excluded.
- CI checks typecheck, lint (including the transaction ban), documentation scope, schema drift, tests
  and build. Local checks do not establish hosted-runtime compatibility, a real
  preview/production deployment, GitHub approval configuration or mobile PWA
  behavior. Verify those flows on the target account; the hosted auth blocker
  noted above must be fixed first.

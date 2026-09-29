# Do Good Arching

A multi-user archery training tracker for **athletes** and **coaches**, built on the
native Cloudflare stack: **Workers** + **D1** (via Drizzle ORM) + **R2**, with a React
single-page app served from the same Worker. Installable as a PWA on iOS and Android.

One deployment is one shared team. Every coach can view and edit every athlete's
**plans** and view **weekly/cycle summaries**, while individual log entries
(sessions, scores, notes) stay private. Coaches get a team overview on Today and
can post meals to every athlete's Fuel; they have no personal training data of
their own. The first coach is the **owner** and can invite other coaches.

This README is the quick start. The [aspec design reference](aspec/foundation.md)
describes architecture, permissions, UX and operations.

Passwords now use 100,000 PBKDF2 iterations. Existing 210k hashes require the
[operator reset](aspec/devops/operations.md#admin-runbook), preserving account data
and ownership. Hosted-preview verification is still required; see
[Verification status](#verification-status).

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
npx wrangler d1 create dogoodarching
```

Copy the returned `database_id` into the top-level `[[d1_databases]]` entry in
`wrangler.toml`.

> **`wrangler.toml` contains this project's real database IDs.** The committed
> `database_id` and `preview_database_id` belong to the maintainers' Cloudflare
> account. Local development and the test suite don't need them, but if you
> deploy to your own account, replace them with the IDs from `wrangler d1 create`;
> otherwise the remote migration and deploy commands fail with a D1 "database
> not found" error.

### 2. Create the R2 bucket (plan attachments: documents/photos)

```bash
npx wrangler r2 bucket create dogoodarching-attachments
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
Existing deployments with uploads must follow that procedure's upload gate,
old-writer drain and size-backfill ordering when deploying the raw-file transport.

### 4. Local development

```bash
npm run build   # typecheck + build the frontend into dist/client
npm run dev     # wrangler dev -> http://localhost:8787 with local D1 + R2
```

On the first run against a fresh database, run the migrations first
(`npm run db:migrate:local`).

### 5. Deploy

```bash
npm run deploy:preview   # builds, then `wrangler preview`
npm run deploy           # builds, then `wrangler deploy` (production)
```

One Worker serves both the API and the app. Routine deploys are handled by
Cloudflare (Workers Builds), not by GitHub Actions; these scripts are for manual
deploys. They build and deploy only: run the matching migrations first.

### Environments

`wrangler.toml` configures production at the top level and preview deployments in
`[previews]`. Previews are Preview deployments of the same Worker (`wrangler
preview`), with their own D1 database and R2 bucket so preview data never touches
production:

| | Worker | D1 | R2 | Deployed by |
|---|---|---|---|---|
| **production** (top-level config) | `dogoodarching` | `dogoodarching` | `dogoodarching-attachments` | Cloudflare |
| **preview** (`[previews]`) | `dogoodarching` (Preview deployments) | `dogoodarching-preview` | `dogoodarching-attachments-preview` | Cloudflare |

Create the preview D1 database and R2 bucket the same way as in steps 1–2
(`npx wrangler d1 create dogoodarching-preview`,
`npx wrangler r2 bucket create dogoodarching-attachments-preview`) and paste
the preview `database_id` into both `[[previews.d1_databases]]` and
`preview_database_id` on the top-level `[[d1_databases]]` (used by
`npm run db:migrate:preview`).

Production and preview both declare 5/min and 10/min Rate Limiting bindings. Production
uses namespaces `1001`/`1002`; preview uses `2001`/`2002`, isolating their counters.
Production declares a `*/15 * * * *` UTC Cron Trigger (`[previews]` has no
`triggers` key, so preview runs no cron) for bounded session/invite cleanup,
durable blob deletion and attachment-size backfill. See
[infrastructure](aspec/devops/infrastructure.md#architecture) and
[cleanup operations](aspec/devops/operations.md#scheduled-cleanup-jobs).

Releases are trunk-based and the `package.json` version is not used. Cloudflare
builds and deploys the Worker; GitHub Actions only runs `CI` on every push/PR:
install, typecheck, lint, schema drift check, tests and build. **CI does not
apply D1 migrations**: make sure the Cloudflare deploy command (or an operator)
runs them before a deploy that needs them. See [CI/CD](aspec/devops/cicd.md).

### Tests and lint

```bash
npm test              # Worker, frontend and build/service-worker projects
npm run test:worker   # Worker tests only (run inside workerd with local D1 + R2, migrations applied)
npm run test:frontend # frontend unit tests only (jsdom)
npm run lint          # ESLint (typescript-eslint); also forbids D1-unsupported `.transaction()`
npm run typecheck     # Worker, frontend and test tsconfigs
npm run db:check      # drizzle-kit must produce no migration/snapshot changes
npm run docs:check    # design-reference placeholder check
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
   `https://your-app.workers.dev/invite#<token>`, and share it out of band.
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

| Capability | Athlete | Coach | Owner (initially first coach) |
|---|---|---|---|
| Own training data and export/import | Full access | None | None |
| Athlete plans, schedule and attachments | Own only | View/edit all athletes | View/edit all athletes |
| Athlete weekly/cycle summaries | Own only | View all athletes | View all athletes |
| Team overview (coach Today) | No | Yes | Yes |
| Team meals in Fuel | Read | Add/edit/delete any | Add/edit/delete any |
| Other users' individual logs, scores, notes, gear, maintenance | No access | No access | No access |
| Invite athletes | No | Yes | Yes |
| Invite coaches / list coaches | No | No | Yes |
| List/revoke invites | No | Own invites | All invites |
| Download plan files | Own files | Any plan file | Any plan file |
| Deactivate/reactivate athletes | No | Yes | Yes |
| Transfer ownership to another active coach | No | No | Yes |
| Delete own account with password | Yes | Unless last active coach | Transfer ownership first |

Deactivation revokes sessions and hides an athlete from the default roster while
keeping their data and username; coaches retain plan access. Team's **Show
deactivated** toggle makes reactivation available. Deleting a coach preserves
athletes and files on their plans. See [detailed rules](aspec/foundation.md#personas).

Settings offers password change (keeps this session, revokes others), sign out
everywhere and password-confirmed account deletion. Owners see a transfer picker
instead of deletion. Forgotten passwords require the
[manual admin reset procedure](aspec/devops/operations.md#admin-runbook).

## Data export / import

Athletes get **Settings → Export my data**: a single JSON download
(`dga-export-YYYYMMDD.json`) containing the account's full training data, and a
matching **Import** that replaces the account's data after validation. Export is
strictly per-account — there is no cross-user export. Coaches have no personal
training data, so they have no export/import (the API returns 403). Team meals
are team data: they are not exported and import never creates them.

Limitation: uploaded document/photo attachments live in R2 and are **not**
included in the JSON export (link attachments are). Re-upload files after an
import if needed.

Import accepts at most 8,000,000 UTF-8 request bytes, 20,000 sessions, 5,000 scores, 50,000 ends, six week plans, seven day overrides, 1,000 setups and 5,000 rows in each other array. Every field uses the normal write validators; dates must exist, links must be HTTP(S), sight marks must be an object of strings, and scores must contain ten unique ends with consistent totals. Duplicate IDs/keys and orphan relationships return indexed 400 errors. Program cycles and elapsed-time advancement are capped at 200 cycles.

The complete replacement must fit 40 D1 statements, including guards, cleanup enqueue and mapping removal. JSON row chunks contain at most 1,000 rows and 128,000 UTF-8 bytes; each statement is preflighted for 100 bound parameters, 100,000 SQL bytes and 128,000 bytes per bound string. This deliberately fits the Free plan’s 50-query invocation budget, including authentication and one prompt blob-cleanup attempt, and also works on Paid. Effective capacity depends on row widths and populated collections: the row caps are ceilings, not a promise that every combination fits. Oversize requests/batches return 413 before any destructive write. The operation is never split across committed batches.

AUTOINCREMENT assigns IDs. Temporary per-import UUID/source-ID keys on score and maintenance parents resolve child references inside one D1 batch, then are cleared before commit. Every statement checks that the actor is still active. The same batch records the keys of the actual attachments it replaces in durable cleanup, including concurrent coach uploads. R2 deletion happens only after commit; failure is logged and retried by cron while import still succeeds. Rollback leaves existing rows and referenced files intact. Version-1 null state/poundage, empty collections and ignored legacy `entries` remain supported.

Plan uploads use raw file bodies: **8 MB (8,000,000 bytes) per file**, **100 files
and 500 MB (500,000,000 bytes) per account**, excluding links. Coach uploads count
against the athlete. Accepted types are JPEG, PNG, WebP, HEIC, PDF and
DOC/DOCX/XLS/XLSX/PPT/PPTX; see the [exact MIME allowlist](aspec/architecture/security.md#file-attachments).
Unknown legacy sizes block new files until backfill or attachment deletion;
over-quota accounts can still read/delete files and add links.

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
                      setups, inspiration, team meals, attachments and import/export
migrations/           reviewed SQL migrations and drizzle-kit metadata
scripts/db-check.mjs  schema/migration no-diff check
frontend/
  index.html          SPA shell and PWA meta tags
  sw.js               shell-cache source; Vite injects a build hash into the emitted sw.js
  public/             manifest and PWA icons
  src/
    App.tsx           auth/query gates and tab shell
    api.ts            typed API client
    features/         auth, coach, dashboard, log, plan, gear, fuel, team and settings
    components/       shared UI, navigation and SafeLink
    lib/              client date/format/mutation helpers
    theme.css         Tailwind v4 theme
test/                Worker integration and frontend harness tests
.github/workflows/    CI (typecheck, lint, tests, build)
aspec/                design reference and numbered work items
```

Component responsibilities and data ownership are in the
[architecture reference](aspec/architecture/design.md#major-components).

## API overview

Endpoints are under `/api/*` and require a session cookie except those marked
public. Bodies are JSON except raw file uploads; downloads return bytes.
Unsafe calls require same-origin proof. JSON media-type failures return 415;
CSRF/role failures 403, invalid sessions 401, and unexpected failures 500.
Limited operations can return 429 or fail-closed 503. See [API conventions](aspec/architecture/apis.md)
for validation, error statuses and response formats.

- Auth: `GET /api/auth/status` (public), `POST /api/auth/bootstrap` (public,
  first user), `POST /api/auth/login` (public), `POST /api/auth/accept-invite`
  (public), `POST /api/auth/logout`, `GET /api/auth/me`. Status, login, logout
  and me return 200; bootstrap/acceptance return 201. Login returns 401 for
  invalid credentials; bootstrap can return 409, acceptance 400/409/410;
  public auth writes are limited (429/503).
- Invitations: `POST/GET /api/auth/invites` and `DELETE /api/auth/invites/:id`
  (coach; creating a coach invite requires the owner).
- Tracker, personal plans, gear/checks and transfer below are athlete-only;
  coaches get 403. `GET /api/plan/attachments/:id/file` serves both roles.
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
  `GET /api/coach/athletes/:athleteId/overview` (200; 400 invalid query or
  404 missing/non-athlete target). Coach listing returns 200 or 403 for non-owners.
  `GET /api/coach/overview?today=YYYY-MM-DD` returns every active athlete's
  current cycle, arrow totals and averages (200; 400 invalid query).
- Team meals: `GET/POST /api/coach/meals` and `PUT/DELETE /api/coach/meals/:id`
  (coach; any coach may change any meal; 400 invalid ID, 404 missing meal,
  writes limited 429/503). Athletes see them in `/api/tracker` `recipes[]`.
- Coach plan editing under `/api/coach/athletes/:athleteId`:
  `PUT /plan/sessions`, `PUT /plan/weeks`, `POST /plan/adjust`,
  `POST /plan/sessions/links`, `POST /plan/sessions/files`,
  `DELETE /plan/attachments/:attachmentId`.
- Transfer: `GET /api/export`, `POST /api/import`.

The new/changed contracts below inherit the common statuses above; JSON rows
also return 400 for invalid bodies and 415 for the wrong Content-Type.

| Endpoint | Success and operation-specific errors |
|---|---|
| `POST /api/auth/password` | JSON `{ currentPassword, newPassword }`; 200 `{ ok: true }`; 400 incorrect password, 409 stale hash, 429/503 |
| `POST /api/auth/logout-all` | No body; 200 `{ ok: true }`, all sessions revoked and cookie cleared |
| `DELETE /api/auth/account` | JSON `{ password }`; 200 `{ ok: true }`, cookie cleared; 400 incorrect password, 409 owner/last coach/concurrent change, 429/503 |
| `POST /api/auth/owner/transfer` | JSON `{ coachId, password }`; 200 `{ ok: true, previousOwnerId, newOwnerId }`; 400 self/incorrect password, 403 not owner, 404 ineligible target, 409 stale transfer, 429/503 |
| `GET /api/coach/athletes[?include=deactivated]` | 200 `{ athletes }`, each with ISO/null `deactivatedAt`; 400 other include values |
| `POST /api/coach/athletes/:athleteId/deactivate` | No body; idempotent 200 athlete summary; 404 missing/non-athlete target |
| `POST /api/coach/athletes/:athleteId/reactivate` | No body; idempotent 200 athlete summary; 404 missing/non-athlete target |
| `POST /api/plan/sessions/files` | Athlete; raw body with `dayKey`, `kind`, `label` query and file MIME; 200 `{ id }`; 400 invalid metadata/length/body or changed account/lease, 401 unavailable account, 413 size/quota/unknown accounting, 415 MIME, 429/503, 500 `Upload failed` |
| `POST /api/coach/athletes/:athleteId/plan/sessions/files` | Same raw transport/statuses; additionally 403 role and 404 target; charged to athlete |

Browser uploads send the original File and never set Content-Length themselves.
The client sends `X-File-Size: file.size`; this supplies a verified length when Content-Length is absent. Missing both is 400. Bytes stream to R2 with backpressure, and actual count, EOF and both supplied lengths must agree. Full limits,
error meanings and response shapes are in the [API reference](aspec/architecture/apis.md#design).

## Notes

- No Worker secrets are required. Authentication and import protections are
  documented in [security](aspec/architecture/security.md).
- The service worker uses a content-derived cache name on each changed build and
  deletes old caches on activation, including the legacy `dga-shell-v1` cache.

## License

Apache License 2.0 — see [LICENSE](LICENSE).

## Verification status

**Implementation checks pass; full hosted/device acceptance is still required.**
On 2026-09-28 a disposable Cloudflare temporary account verified bootstrap,
athlete/coach invite acceptance, login, deactivation/reactivation, password and
session controls, ownership transfer, coach deletion and real rate-limit denial.
Chromium 153 verified Workers Static Assets headers on `/`, `/invite`, SPA
fallback and `/sw.js`; the built SPA, React styles, Recharts, service worker and
fragment/legacy invitation flows passed without CSP violations. Frame origins
were tested with controlled responses, not live video playback.

That temporary deployment omitted R2 and Cron after R2 provisioning was rejected
(bucket-not-found on deploy; bucket creation API denied authentication). It is
partial hosted evidence, not the configured preview environment. Browser File
upload/download passed against local Worker/R2 with byte comparison. Hosted R2
upload/download, backfill/cleanup and Cron, live embed playback, and physical
installed iOS/Android PWA checks remain required before completion. Record
supported OS/browser versions and same-origin request headers on those devices;
never weaken CSRF checks to accommodate an unverified client. Hosted Cron can
only be verified in production, because preview declares no Cron Trigger. The
temporary URL is short-lived and is not a
production or persistent preview deployment.

Automated coverage present in the repository includes:

- Worker Vitest tests run in workerd with migrated local D1/R2. Auth/hash/limiter
  suites cover supported counts, lower-count upgrades, malformed/210k rejection,
  conditional rehash, operator reset and session revocation, binding selection,
  username/IP keys, 429/503 and removal of `rate_limits`. Limiter tests use mocks;
  they do not prove hosted per-location enforcement.
- Lifecycle, cleanup and adversarial suites exercise password/session controls,
  deletion cascades and retained athlete data/invites, deactivation, transfer
  conflicts/races, durable R2 retry after account deletion, scheduled expiry and
  retained live blobs. Coach-overview tests inspect SQL projections/table access
  as well as response privacy and aggregate parity.
- Attachment tests cover raw bodies, MIME normalization, declared/observed size,
  missing/mismatched lengths, 100-file/500-MB boundaries, concurrent admission,
  coach quota attribution, failed commits, deactivation/deletion during upload,
  abandoned-upload recovery and resumable size backfill. CSRF/header tests cover
  JSON/raw/bodyless requests, errors and downloads.
- Migration tests exercise legacy data, ownership/FKs and populated 0002 upgrades
  with repeatable backfill. Existing tracker tests cover pagination, atomic writes,
  local-calendar defaults, version-1 round trips, bounded atomic imports, indexed validation, concurrent parent mapping, safe R2 rollback and durable post-commit cleanup. Performance tests check bounded selected rows/query count,
  not constant database work as history grows.
- Existing frontend jsdom suites cover plan API methods, safe links/file opening,
  history refresh races, missing-row/double-delete handling, invitation controls,
  signup copy and poundage saving. Permanent security-control suites also cover Settings lifecycle, ownership transfer, Team deactivation, raw File/MIME/size transport, fragment/legacy routes in StrictMode and account-cache isolation.
  jsdom does not enforce CSP.
- Build/service-worker tests check exact `_headers` copying, content-derived
  cache identity, old-cache removal, network-only APIs and invite shell navigation
  without token-bearing cache keys. Static build checks do not prove hosted headers.

CI checks typecheck, lint
(including the D1 transaction ban), schema drift, tests and build. Work items and
owner-managed `aspec/devops/subagents.md` are excluded from the docs placeholder
check. GitHub approval settings and live environment behavior require separate
verification.

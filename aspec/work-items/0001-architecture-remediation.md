# Work Item: Task

Title: Architecture remediation from the 2026-09-26 architecture & security review
Issue: TBD

## Summary:
- Fix the architecture and correctness findings in `REVIEW.md`: C1, M5 and A1–A12.
- C1 is a blocker. Bootstrap and accept-invite use `db.transaction()`, which D1 rejects, so nobody can create an account. Do it first, together with the test harness (A1) that would have caught it.
- This item comes first. Security findings are in work item 0002, which builds on the test harness and module layout set up here.
- It also changes the team model to a shared coaching team with an owner (§13), and fills in the `aspec/` folder (§14). Every file in `aspec/` is currently an unfilled template, so the "follow the project's aspec" instruction in work items doesn't point to anything yet.

### Decisions (confirmed with the product owner, 2026-09-28)
- **Team model:** one deployment is one team. Every coach can see and edit every athlete's plans and summaries. There are no per-coach teams (§13).
- **Owner:** the first (bootstrap) coach is the owner. Only the owner can invite coaches; any coach can invite athletes (§13). Ownership transfer and account deletion rules are in 0002 §7.
- **New athlete defaults:** a generic, clearly editable starter weekly plan. The program starts at cycle 1, week 1, and the UI asks for poundage. Existing users get their program state backfilled so what they see doesn't change (§8).
- **Environments:** separate preview and production environments, each with its own D1 database and R2 bucket (§2).
- **Deploys:** CI deploys to preview automatically on merge to `main`, running migrations first. Production is a manually triggered workflow (§2).
- **Versioning:** trunk-based. Each production deploy is identified by its git commit SHA; the `package.json` version isn't used (§2).
- **Out of scope:** `.awman/` and `aspec/devops/subagents.md`; the product owner handles these by hand.

## User Stories

### User Story 1:
As a: coach or athlete

I want to:
create my account (coach bootstrap, athlete invite acceptance)

So I can:
start using the app (both flows return 500 on D1 today)

### User Story 2:
As a: athlete or coach

I want to:
open uploaded documents and photos from a plan

So I can:
actually use the attachments that were uploaded (the "Open" link never renders for files)

### User Story 3:
As a: new athlete

I want to:
start with a neutral program state and plan

So I can:
set up my own training instead of inheriting cycle 2 / week 6 and someone else's program

### User Story 4:
As a: developer

I want to:
have automated tests, CI, one schema source of truth and small, focused modules

So I can:
change the app confidently without regressions or schema drift

### User Story 5:
As a: developer or coding agent picking up a work item

I want to:
read an accurate `aspec/` describing the project's purpose, personas, architecture, APIs, security model, UX and operations

So I can:
make changes that fit the existing design without reverse-engineering it from the code

### User Story 6:
As a: owner (the first coach)

I want to:
invite other coaches, who share the whole team of athletes with me

So I can:
run a club with several coaches without each coach managing a separate roster

### User Story 7:
As a: long-term user

I want to:
dashboard loads that stay fast as my history grows

So I can:
keep using the app for years of training

## Implementation Details:

### 1. Replace D1 transactions with batches (C1): `src/routes/auth.ts:98`, `:173`
- **Bootstrap:** a single statement, `INSERT INTO users (...) SELECT ?,?,?,'coach',1 /* is_owner */,? WHERE NOT EXISTS (SELECT 1 FROM users)`. If `meta.changes !== 1`, return 409. See §13 for the `is_owner` column.
- **Accept invite:** a single `db.batch([...])` of:
  1. `UPDATE invites SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at > ?`
  2. `INSERT INTO users (...) SELECT ... WHERE EXISTS (SELECT 1 FROM invites WHERE id=? AND used_at=?)`, with the role taken from the invite (§13)

  The batch is atomic, so a username UNIQUE violation also rolls back the claim. Map "claim changed 0 rows" to 410 and a UNIQUE violation to 409.
- Remove every `db.transaction()` call and add a lint rule or grep check in CI that forbids it.
- Remove the incorrect "race-safe" comments.

### 2. Test harness, CI and lint (A1)
- Add `vitest` + `@cloudflare/vitest-pool-workers` with D1 migrations applied per test file, and R2 bound.
- Add `npm test`. Add a GitHub Actions workflow that runs `npm ci`, `typecheck`, `lint` and `test`, then `build`, on every PR and push.
- **Environments:** add `[env.preview]` to `wrangler.toml` with its own D1 database, R2 bucket and Worker name. Production keeps the top-level config. Add `npm run deploy:preview` and `npm run db:migrate:preview` scripts.
- **Continuous deployment:**
  - On merge to `main`, after the checks pass: apply remote migrations to the preview D1, then deploy the Worker to preview.
  - Production is a separate `workflow_dispatch` workflow with a GitHub environment requiring approval. It takes a commit SHA (defaulting to the current `main`), runs the checks, applies production migrations, then deploys.
  - Store the Cloudflare API token and account ID as GitHub environment secrets, scoped to the Workers, D1 and R2 permissions the deploy needs.
  - Set the Worker's version message or tag to the git SHA, so a deploy can be traced to its commit.
- **Versioning:** trunk-based on `main`. The git SHA identifies a release; don't bump or rely on the `package.json` version.
- Add ESLint (typescript-eslint) with a minimal config. Include `no-restricted-syntax` / `no-restricted-properties` for `.transaction(`.
- Seed initial integration tests:
  - auth: bootstrap, including a concurrent double-bootstrap
  - invite accept: expired, reused, concurrent accept, taken username
  - login/logout
  - RBAC matrix (with the §13 team model): an athlete can't reach `/api/coach/*`; any coach can reach any athlete; a coach can't use coach endpoints on another coach's account; an athlete can't download another athlete's attachment (404); only the owner can create coach invites
- Update the README's "Verification status" section with what's covered now.

### 3. Single schema source of truth (A2) and referential integrity (A3)
- Add `drizzle-kit` with `drizzle.config.ts` (dialect sqlite, driver d1-http, out `migrations/`).
- Move every index from `0001_init.sql` into `schema.ts`, including the `lower(username)` unique index, using `uniqueIndex(...).on(sql\`lower(${t.username})\`)`.
- Add a migration `0002_*` that:
  - adds foreign keys from every `user_id` column to `users(id) ON DELETE CASCADE`. SQLite needs a table rebuild for this, so generate it and review it by hand.
  - applies the §13 `users` and `invites` column changes (including the `invited_by` FK, `ON DELETE SET NULL`)
  - drops the unused `entries` table (see §8)
  - backfills `program_state` for existing users (see §8)
- Don't add an index to `rate_limits`; 0002 replaces the table with the Workers Rate Limiting binding and drops it.
- CI check: running `drizzle-kit generate` produces no diff.

### 4. Module restructure (A4)
- `src/lib/validation.ts`: all Zod schemas and enums (`sessionInput`, `httpUrl`, `dateInput`, ...).
- `src/lib/dates.ts`: `isoWeekKey`, `mondayDate`, `datedProgramState`, `shiftProgramState`, `addUtcDays`, `dateKeyUtc`.
- `src/lib/http.ts`: JSON body reading, error helpers, `parsePositiveInt` (currently duplicated in `tracker.ts` and `coach.ts`).
- `src/services/*.ts`: domain functions that take `(db, userId, input)`. Split by area: plan, sessions, scores, maintenance, setups, inspiration, attachments, transfer.
- `src/routes/*.ts`: thin handlers only. No route module imports from another route module.
- Replace the roughly 25 copies of the read-body/parse/400 boilerplate with `@hono/zod-validator`. Keep the error body shape `{ error: string }`.
- Split `frontend/src/App.tsx` (1,210 lines) into per-feature components under `frontend/src/features/` (auth, dashboard, log, plan, gear, fuel, team, settings) and `frontend/src/components/` (shared UI such as `SafeLink`).

### 5. Dashboard payload performance (A5): `getTrackerPayload`
- Compute weekly arrow totals and the session-date set with SQL (`GROUP BY` week and `DISTINCT session_date`), limited to the date range the cycle summaries need.
- Load practice score ends only for the ≤100 score IDs returned (`inArray`).
- Keep the 100-row cap on sessions and add cursor pagination (`?before=`) for history screens.
- Auth middleware: one query joining `sessions` and `users` instead of two sequential queries.

### 6. Mutations report not-found (A6)
- Update/delete handlers must check `meta.changes` and return 404 when nothing matched: `updateSessionFor`, `deleteSessionFor`, `deletePracticeScoreFor`, `updateMaintenanceItemFor`, `deleteMaintenanceItemFor`, and `saveSetupFor` when an `id` is given.
- Check the frontend handles 404 on these, for example by invalidating and refetching.

### 7. Atomic multi-statement writes (A7)
- `addPracticeScoreFor`: insert the score and its ends in one batch. Use a subquery for `score_id`, or pre-read the next ID another way; don't use `max(id)`.
- `clearMaintenanceSectionFor`: a single `INSERT ... SELECT ... ON CONFLICT DO UPDATE`, or one batch.
- `addMaintenanceItemFor`: compute `sort_order` inside the insert with `COALESCE((SELECT MAX(sort_order)+1 ...), 0)`.

### 8. Reference-implementation leftovers (A8)
- **Program state:** replace the hard-coded default (`poundage 24, cycle 2, week 6` at `tracker.ts:225` and `:489`) with cycle 1, week 1 and no poundage. Keep it in one constant.
  - Make `current_poundage` nullable (or add a "not set" state). When it isn't set, the dashboard asks the athlete for their poundage before showing poundage-dependent content, and saves it to `program_state`.
  - Backfill: the migration inserts a `program_state` row of `24 / cycle 2 / week 6` anchored to the migration date for every existing user with no row, so what existing users see doesn't change. Check the anchor against `datedProgramState` so the backfilled users land on the same week they see today.
- **Starter plan:** rewrite `plannedSessionDefaults` as a generic 7-day template: neutral session types and short descriptions, with no personal prescriptions. Label it in the UI as a starter plan that the athlete or a coach can edit.
  - Remove the bundled SPT band-workout images (`frontend/src/assets/wednesday-spt-band-workout-page-*.png`) and the UI that shows them. Anyone who wants them can add them as plan attachments.
  - Existing saved overrides are unaffected; only days that still use the defaults change.
- Remove the unused `entries` table from the schema, export and import. Import should accept and ignore `entries` for backward compatibility with existing export files.

### 9. Frontend attachment links (M5): `frontend/src/App.tsx:86-99`
- Change `safeHttpUrl` to resolve against `window.location.origin` (`new URL(value, window.location.origin)`). Allow http/https, and allow same-origin paths only under `/api/plan/attachments/`.
- For same-origin file links, don't use `target="_blank"` with `noopener`, because that can drop the session in some PWA contexts. Use a plain link or a download attribute.

### 10. Timestamp convention (A9)
- Document one convention in `src/db/schema.ts` and `aspec/architecture/design.md`: instants are epoch-ms integers via `timestamp_ms`, and calendar dates are `YYYY-MM-DD` strings in the athlete's local calendar, supplied by the client as `today`.
- Change the raw-integer instant columns (`sessions.expires_at`, `invites.expires_at`) to the same Drizzle mode, or add a code comment explaining why they differ.

### 11. Download filename (A10): `tracker.ts:724`
- Send `Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<percent-encoded>` and add the extension that matches the MIME type.

### 12. Repo hygiene (A11) and service worker cache (A12)
- Add a `.gitignore` covering `node_modules/`, `dist/`, `.wrangler/`, `.dev.vars`, `.DS_Store` and `*.log`. Delete `.DS_Store`. Leave `.awman/` alone; the product owner handles it.
- Add a clear failure message or README callout for the placeholder `database_id`.
- Service worker: inject a build hash into `CACHE_NAME` from a Vite plugin or build step, so each deploy creates a new cache and `activate` deletes the old one.

### 13. Shared coaching team and owner role
Today each athlete belongs to one coach (`users.coach_id`), and only one coach can ever exist. The new model is: **one deployment is one team.**
- **Schema** (in the §3 migration):
  - `users.is_owner` (boolean, default false). At most one owner, enforced with a partial unique index `ON users(is_owner) WHERE is_owner = 1`. The migration marks the existing coach as the owner.
  - Replace `users.coach_id` with `users.invited_by` (nullable FK to `users(id)`, `ON DELETE SET NULL`). It's only a record of who sent the invite and grants no access. Copy existing `coach_id` values into it.
  - `invites.role` (`'athlete' | 'coach'`, default `'athlete'`). Rename `invites.coach_id` to `invites.created_by`.
- **Access rules:**
  - Any coach can list all athletes and view or edit any athlete's plans and summaries. `resolveAthlete` checks `role = 'athlete'` only; the coach-ID condition goes away.
  - `GET /api/coach/athletes` returns every athlete in the deployment.
  - `getAttachmentForDownload` allows the owner of the attachment, or any coach.
  - Coaches still never see athletes' private logs. That rule doesn't change.
- **Invites:**
  - `POST /api/auth/invites` takes `{ role }`, defaulting to `"athlete"`. `role: "coach"` is allowed only for the owner; any other caller gets 403.
  - Any coach can create athlete invites.
  - Invite listing and revoking: the owner sees and can revoke all invites. Other coaches see and revoke only their own.
  - Accept-invite creates the user with the invite's role and `invited_by = created_by`.
  - Validity:
    - athlete invites stay valid even if the coach who created them has been deleted, because the team is deployment-wide
    - coach invites are valid only while their creator is still the owner at accept time (checked in the §1 batch)
- **API:** add `isOwner` to `/api/auth/me` and to `publicUser`. Keep `coachId` out of responses, since it's no longer meaningful.
- **Frontend:**
  - The Team tab lists all athletes.
  - The owner sees an "Invite coach" option next to "Invite athlete", and a list of coaches.
  - Remove any "my team" wording that implies per-coach rosters.
- **README:** update the roles table and the "First run" section to describe the owner, coach invites and the shared team.
- Deactivating athletes, ownership transfer and account-deletion rules are in 0002 §7.

### 14. Fill in the `aspec/` folder
Replace every placeholder (`projectname`, `[a | b]` choices, `- guidance`, `- description`, the example mermaid diagram) with the project's real details. Rules:
- Describe the project **as it will be once this item is done** (new module layout, batch-only D1 writes, test harness, CI). Where 0002 will change something, describe the current behaviour and add a `Planned (work item 0002):` note. Don't document it as done.
- Keep each file's heading structure so the templates stay recognisable. Add or remove numbered sections (Persona N, Component N, Principle N) to fit.
- If a file doesn't apply, keep it and replace the body with one line saying `Not applicable:` and why. Don't delete it.
- Each fact lives in one place. Other files link to it (for example, `security.md` refers to `foundation.md` for the RBAC table instead of copying it). The README stays the user-facing quick start; `aspec/` is the design reference, and each can link to the other.
- Take facts from the code, `README.md`, `wrangler.toml`, `REVIEW.md` and the Decisions list at the top of this item. Don't invent requirements. If you hit a decision that isn't covered, ask the product owner before writing it down. Don't leave open-question lists in the aspec.

Per file:

- **`foundation.md`**
  - Name: Do Good Arching. Type: saas. Purpose: multi-user archery training tracker for athletes and their coach.
  - Frontend: TypeScript; React 19, Tailwind CSS v4, TanStack Query, Recharts, Vite; installable PWA.
  - Backend: TypeScript on Cloudflare Workers; Hono, Zod, Drizzle ORM (D1), R2. No Node-only APIs.
  - Guidance bullets for each side, reflecting §4 (thin routes, services, shared validation, feature folders in the frontend).
  - Best practices: keep the template's three bullets. Add project-specific ones:
    - every tracker query is scoped by `user_id`
    - coach access to athlete data only goes through `resolveAthlete`
    - D1 writes that must be atomic use `batch()`
    - validation schemas are shared between the write endpoints and import
  - Personas:
    - **Owner:** the first coach. Everything a coach can do, plus inviting coaches and (after 0002) transferring ownership.
    - **Coach:** part of the deployment-wide team. Invites athletes, views and edits every athlete's plans, sees weekly/cycle aggregates. Never sees athletes' individual logs.
    - **Athlete:** full access to own data; plans and summaries are visible to all coaches.
    - Write each persona's RBAC allowed/disallowed lists from §13 and the README's roles table (updated per §13).

- **`architecture/design.md`**
  - Pattern: monolith (one Worker serving the API and the SPA through Workers Static Assets).
  - Design principles, each with reasoning:
    - per-user data isolation
    - one deployment is one team: all coaches share all athletes
    - coach access limited to plan and aggregate data, enforced server-side and at the query level
    - atomic D1 writes via `batch()`, never `transaction()`
    - one schema source of truth (`schema.ts` → drizzle-kit migrations)
    - Cloudflare-native only (WebCrypto, no Node APIs)
    - the API is the source of truth; the PWA caches only the shell
  - High-level architecture: replace the example with a real mermaid diagram:
    - browser/PWA
    - service worker
    - Worker, with Hono routes → services → Drizzle
    - D1
    - R2
    - Static Assets
    - `run_worker_first` for `/api/*`
    - preview and production environments
    - the Cron Trigger and Rate Limiting binding that 0002 adds (marked as planned)
  - Major components (one section each):
    - Worker entry/router
    - auth & sessions (`lib/auth`, `lib/rbac`)
    - rate limiting
    - tracker services
    - coach routes
    - import/export
    - attachments (R2)
    - D1 schema & migrations
    - SPA
    - service worker
  - Data model summary: tables grouped by auth / tracker / plan, with ownership (`user_id`), the FK/cascade rules from §3, and the §13 owner/invite columns.
  - The timestamp convention from §10.

- **`architecture/apis.md`**
  - Convention: rest. Protocol: http.
  - Versioning: unversioned `/api/*`. The SPA and API deploy together from one Worker, so they can't drift. Say what would trigger adding `/api/v2`, for example a native mobile client.
  - Objects:
    - JSON request and response bodies
    - errors always `{ error: string }` with the status codes used (400, 401, 403, 404, 409, 410, 413, 415, 429, 500)
    - dates as `YYYY-MM-DD`, instants as ISO strings in responses
    - IDs: UUID strings for users, integers for tracker rows
  - Authentication: `dga_session` cookie (HttpOnly, SameSite, Secure over HTTPS), 30-day TTL, token stored hashed. The public endpoints are status, bootstrap, login and accept-invite.
  - Conventions:
    - Zod validation on every body via `@hono/zod-validator`
    - coach routes nested under `/api/coach/athletes/:athleteId/...`, usable by any coach for any athlete
    - mutations return 404 when nothing matched (§6)
    - link to the README's endpoint list instead of copying it

- **`architecture/security.md`**
  - Transport: HTTPS via Cloudflare; the `Secure` cookie flag.
  - Authentication:
    - username + password, PBKDF2-SHA256 via WebCrypto, with the iteration count and the hosted-Workers 100k limit
    - session and invite tokens: 256-bit random, stored as SHA-256
    - invites: single-use, 24h
  - RBAC:
    - how `authMiddleware`, `requireCoach`, `resolveAthlete` and the owner check on coach invites enforce the persona rules from `foundation.md`
    - the rule that coach code paths never query private log tables
  - Add sections for:
    - input validation: shared schemas, http/https-only URLs
    - file attachments: ownership check, `attachment` disposition, `nosniff`
    - rate limiting
    - secrets: none today. Note the accepted risk that bootstrap is public (review finding H1, deferred).
  - Add a `Planned (work item 0002):` list covering CSRF, headers, upload quotas, import hardening, the Rate Limiting binding, athlete deactivation, ownership transfer and account deletion.

- **`devops/infrastructure.md`**
  - Deployment platform: Cloudflare Workers. Cloud platform: Cloudflare. Automation: Wrangler (`wrangler.toml`); no Terraform.
  - Resources and bindings: Worker, D1 `do-good-arching` (`DB`), R2 `do-good-arching-attachments` (`ATTACHMENTS`), Static Assets, and any Cron Trigger or rate-limit binding.
  - Best practices:
    - pin `compatibility_date`
    - separate preview and production environments (`[env.preview]`, with its own D1 and R2), per §2
    - note which runtime limits matter: CPU time, PBKDF2 iterations, D1 batch/statement limits, request body size
  - Security and RBAC: who holds Cloudflare account access, and the scoped CI deploy token stored as a GitHub environment secret. The R2 buckets are private and reachable only through the Worker.

- **`devops/operations.md`**
  - Installing and running: summarise the README's quick start steps (D1/R2 creation, `database_id`, migrations, build, deploy) and link to it.
  - Environment variables: none today; say so. Secrets: none in the Worker today. If 0002 or later adds any, list them with `wrangler secret put`. List the CI secrets (Cloudflare API token, account ID) and where they live.
  - Environments: how preview and production differ, and how to run migrations and deploys against each.
  - Version upgrades: how to bump dependencies and `compatibility_date` safely (run the test suite plus a preview deploy).
  - Database migrations:
    - generate with drizzle-kit
    - never edit applied migrations
    - apply local first, then preview (CI does this on merge), then production (the manual deploy workflow does this)
    - back up first with `wrangler d1 export`
    - D1 Time Travel for restores
  - Add sections for:
    - backups & restore (D1 Time Travel, R2)
    - logs (`wrangler tail`, Workers Logs)
    - the admin runbook: manual password reset via `wrangler d1 execute`, until 0002 adds self-service
    - scheduled cleanup jobs

- **`devops/cicd.md`**
  - Platform: github.
  - Build: `npm ci`, typecheck, lint, `vite build`.
  - Test: vitest-pool-workers plus the drizzle-kit no-diff check (§2, §3).
  - Releases/versioning: trunk-based; the git SHA identifies each release; the `package.json` version isn't used.
  - Publishing: not applicable; nothing is published to a registry.
  - Deployment: automatic to preview on merge to `main`; production via the approved manual workflow. In both, migrations run before the Worker deploy (§2).

- **`devops/localdev.md`**
  - Development: local, with `Dockerfile.dev` available. Build tools: npm.
  - Developer loop:
    - `npm run db:migrate:local`
    - `npm run build && npm run dev` (Worker + SPA on :8787)
    - `npm run dev:client` for frontend-only Vite work
  - Note that `wrangler dev` needs `wrangler login`, and that local `workerd` doesn't enforce hosted limits such as the PBKDF2 cap.
  - Local testing: `npm test`, and inspecting local D1 with `sqlite3` under `.wrangler/state`.
  - Version control: branch off `main`, the `.gitignore` from §12, never commit `.wrangler/`.
  - Documentation: the README is the user-facing guide; `aspec/` is the design reference; work items live in `aspec/work-items/` and are numbered.

- **`devops/subagents.md`**: leave it as it is. The product owner is handling `.awman/` and this file.
- **`uxui/experience.md`**
  - Signup flow: first-coach bootstrap, magic-link athlete invites shared out of band, no email.
  - Account management: today's state, plus the planned 0002 features.
  - Invitations & team management: one deployment-wide team; the owner invites coaches, any coach invites athletes; invite create/list/revoke; 24h single-use. Planned in 0002: athlete deactivation and ownership transfer.
  - RBAC: link to `foundation.md`.
  - Billing: not applicable.
  - Login flow: username + password with 30-day sessions.
  - Notifications: none.
- **`uxui/interface.md`**
  - Style: describe the existing look from `theme.css` and `App.tsx`: accent colour tokens, light/dark via `color-scheme`, mobile-first PWA with safe-area insets.
  - Layout & menus: the athlete and coach tab navigation (`athleteNav` / `coachNav`) and the tabs each has.
  - Empty states: the existing `Empty` component pattern.
  - Accessibility: what's in place (labels, `aria-*`, `role="status"`) and known gaps.
  - Machine use: the JSON export/import format.
- **`uxui/setup.md`**
  - Download: install as a PWA on iOS and Android, per the README.
  - Initial configuration: first-run coach bootstrap.
  - Superuser access: the owner is the highest role in the app (coach invites, ownership transfer). Point to the operations runbook for database-level admin tasks.
- **`uxui/cli.md`**: `Not applicable:` there's no CLI.
- **`genai/agents.md`**: `Not applicable:` the app has no LLM or agent features.

When later sections of this item change a decision (module layout, FK rules, CI steps), update the matching aspec file in the same PR, so `aspec/` is accurate when the item closes.

## Edge Case Considerations:
- Bootstrap: two concurrent requests. Exactly one gets 201 and the other gets 409, with no orphan user and no 500.
- Invite accept:
  - concurrent accepts of the same token: one 201 and one 410
  - a taken username: 409, and the invite is **not** consumed
  - an invite that expires between the read and the batch
  - an athlete invite whose creating coach has since been deleted: still accepted
  - a coach invite whose creator is no longer the owner at accept time: rejected with 410
  - a non-owner coach trying to create a coach invite: 403
- FK migration: existing rows whose `user_id` has no matching user, from earlier local testing. The migration must either clean them up or fail loudly. Test it against a copy of a populated local DB.
- Removing `entries`: old export files that contain `entries` must still import.
- Default-state change: the backfill must leave existing users on exactly the cycle, week and poundage they see today, including users with no `program_state` row. New users start at cycle 1 / week 1 and are asked for poundage.
- Team-model migration: a database with no coach (for example a fresh one) must migrate cleanly. A database with the existing single coach must mark that coach as owner. Athletes whose `coach_id` points to a missing user get `invited_by = NULL`.
- Starter plan: days where a user saved an override keep it; only default days show the new template.
- Pagination: sessions on the same date, and ties on `id`.
- 404-on-no-match: frontend optimistic updates and double-click deletes, where the second delete now returns 404.
- Attachment links: relative URLs, absolute same-origin URLs, cross-origin http links, and malformed values.
- Service worker: users on the old `dga-shell-v1` cache must upgrade cleanly.
- aspec: work item 0002 changes security, experience and operations details. Label those as planned rather than current, and have 0002 update the same files when it lands, so they don't go stale in either direction.

## Test Considerations:
- Integration (vitest-pool-workers):
  - all bootstrap and invite cases above, including concurrency via `Promise.all`
  - RBAC matrix across every `/api/coach/*` route
  - 404 for each mutation that targets another user's ID
  - practice score insert is atomic (a forced failure leaves no orphan score)
  - maintenance section clear
  - `sort_order` under concurrent adds
  - team model: two coaches both see and edit the same athlete; owner-only coach invites; accept-invite gives the invite's role; `/api/auth/me` returns `isOwner`
  - defaults: a new athlete gets cycle 1 / week 1, no poundage and the starter plan; a backfilled user sees the same state as before the migration
- Unit tests:
  - date helpers (ISO week at year boundaries, `datedProgramState` across cycle rollover, negative shifts clamped at 0)
  - `safeHttpUrl` / `SafeLink`
  - the Content-Disposition builder with non-ASCII and quote characters
- Schema: CI asserts that `drizzle-kit generate` produces no diff, and that migrations apply cleanly to an empty DB and to a seeded 0001 DB.
- Performance smoke: seed 5k sessions and 1k scores, then check `GET /api/tracker` query count and response time stay flat compared with 100 sessions.
- aspec review:
  - `grep -rnE 'projectname|- guidance|- description|- details|\[[a-z]+ [|]' aspec --include=*.md --exclude-dir=work-items` returns no matches
  - a reviewer spot-checks at least the personas/RBAC, component list, API conventions and migration procedure against the code
  - the mermaid diagram renders on GitHub
- CD: a merge to `main` deploys to preview with migrations applied first. The production workflow can't run without approval and deploys the chosen SHA.
- Manual: `npm run dev` end-to-end (bootstrap → invite coach → invite athlete → accept both → log session → upload → open attachment → export/import), then the same on the preview environment.

## Codebase Integration:
- follow established conventions, best practices, testing, and architecture patterns from the project's aspec.
- Complete this item before starting 0002 (security), so the security changes land in the new module layout and test harness and not in `routes/tracker.ts`.
- The `aspec/` folder is filled in as part of this item (§14). Work item 0002 and later ones follow it and must keep it up to date.
- Keep the API response shapes unchanged unless this item says otherwise, since `frontend/src/api.ts` is typed against them.

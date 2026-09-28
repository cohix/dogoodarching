# Architecture & Security Review — Do Good Arching

**Date:** 2026-09-26
**Scope:** Whole repository, untracked working tree with no commits yet: Worker (`src/`), schema/migrations, frontend (`frontend/`), config.
**Method:** Manual code review. I checked the two blocking issues against the pinned dependency sources: `drizzle-orm@0.45.3` from `package-lock.json`, and the `workerd` runtime binary (1.20260926.1). I ran PBKDF2 in a local `workerd`. I didn't run `wrangler dev` or deploy anything.

---

## Summary

The codebase is small, readable and consistent about per-user data scoping. The basic security choices are sound: passwords are hashed with PBKDF2, session and invite tokens are stored hashed, cookies are `HttpOnly`, all queries are parameterised, and every coach route checks team membership.

However, **the app very likely cannot sign anyone up in its current state**. The first-run coach bootstrap and invite acceptance both use a database transaction mechanism that Cloudflare D1 rejects. The README says the end-to-end HTTP flows were never run, and that is why this was missed.

Beyond that, most of the risk sits in three places:

- the **public first-user bootstrap**
- the **import endpoint**, which skips all the validation the normal write paths enforce
- **file uploads**, which have no quota

The main architectural gaps are **no tests at all**, a **schema defined by hand in two places**, and **no account-lifecycle features** such as password reset, account deletion or removing an athlete.

| # | Severity | Area | Finding |
|---|---|---|---|
| C1 | Critical | Correctness | Bootstrap and accept-invite use `db.transaction()`, which D1 rejects, so no account can be created |
| C2 | High | Correctness | PBKDF2 uses 210,000 iterations, but production Workers allows at most 100,000 |
| H1 | High | Security | Whoever reaches a fresh deploy first becomes the coach |
| H2 | High | Security | `/api/import` skips every validation rule the normal write paths enforce |
| H3 | High | Data integrity | Import deletes R2 files before its (fallible) DB batch runs, and its ID remapping can collide with other users' rows |
| H4 | High | Security/Cost | Uploads have no quota or MIME allowlist, and the base64-in-JSON upload is CPU/memory heavy |
| H5 | Medium-High | Security | CSRF protection relies only on `SameSite=Lax`; there's no Origin or Content-Type check |
| M1 | Medium | Security | No security headers (CSP, frame-ancestors, HSTS, Referrer-Policy) |
| M2 | Medium | Security | Login rate limit is per-IP only; the limiter itself is racy and does a full table scan on every call |
| M3 | Medium | Security/Product | No password change/reset, session revocation, account deletion or athlete removal |
| M4 | Medium | Privacy | Coach overview loads the athlete's full private data and then filters it |
| M5 | Medium | Correctness | Uploaded document/photo attachments can never be opened in the UI |
| M6 | Low-Med | Security | Raw internal error messages are returned to clients on upload failure |
| A1–A12 | — | Architecture | Tests, schema drift, integrity, module structure, performance, leftovers (see below) |

---

## Critical / blocking

### C1. D1 does not support `db.transaction()`: signup is broken
**Where:** `src/routes/auth.ts:98` (bootstrap), `src/routes/auth.ts:173` (accept-invite)

In `drizzle-orm@0.45.3`, `D1Session.transaction()` sends a raw `begin` statement (`d1/session.js:65`). Nested calls send `savepoint`. The Workers runtime rejects both with:

> *To execute a transaction, please use the state.storage.transaction() … instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.*

That string is in the current `workerd` binary. Cloudflare's D1 docs also say interactive transactions aren't supported and that `batch()` is the atomic unit.

**Impact:** `POST /api/auth/bootstrap` and `POST /api/auth/accept-invite` throw, which the global handler turns into a 500. Nobody can create the first coach or join as an athlete, so the app is unusable from first run. The "race-safe" comments are also wrong, because even if `begin` ran, D1 statements from a Worker aren't executed on a single connection.

**Fix:** Replace both with a single `db.batch([...])` of conditional statements:
- **Bootstrap:** `INSERT INTO users (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)`, then check `meta.changes === 1`.
- **Accept invite:** one batch of `UPDATE invites SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at > ?` followed by `INSERT INTO users ... SELECT ... WHERE EXISTS (SELECT 1 FROM invites WHERE id=? AND used_at=?)`. A batch is atomic, so a username UNIQUE violation rolls back the invite claim too.
- Add an integration test for each (see A1).

### C2. PBKDF2 iteration count is above the production Workers limit
**Where:** `src/lib/auth.ts:5`, `hashPassword` and `verifyPassword`

`workerd` has a configurable PBKDF2 limit ("*Pbkdf2 failed: iteration counts above N are not supported*"). Cloudflare's hosted runtime sets it to **100,000**. The open-source `workerd` used by `wrangler dev` doesn't enforce it: I confirmed 210,000 succeeds locally. That means this passes local testing and **fails in production** on every `hashPassword` and `verifyPassword` call, breaking bootstrap, login and invite acceptance.

**Fix:** Drop to 100,000 iterations, or use a Workers-compatible scrypt/argon2 via WASM if you want a stronger KDF. Also make `verifyPassword` read the iteration count from the stored hash instead of rejecting anything that isn't equal to the constant (`auth.ts:43`). Right now, changing the constant later would lock out every existing user. Confirm on a preview deployment (`wrangler deploy --dry-run` isn't enough; use a real `workers.dev` preview).

---

## High

### H1. Public first-user bootstrap: deployment takeover window
**Where:** `src/routes/auth.ts:80-120`, `GET /api/auth/status`

Any unauthenticated visitor can call `/api/auth/status` to see `setupRequired: true`, then `POST /api/auth/bootstrap` to become the only coach. Between `wrangler deploy` and the owner's first visit, a scanner or anyone who guesses the `*.workers.dev` URL can take the deployment. There's no way to recover from this other than editing D1 by hand.

**Fix:** Require a one-time secret for bootstrap, for example `wrangler secret put BOOTSTRAP_TOKEN` checked with a constant-time compare, or create the first coach with a CLI/`wrangler d1 execute` script and remove the endpoint.

### H2. Import skips all write-path validation
**Where:** `src/routes/export.ts:23-78`, `POST /api/import`

The normal endpoints use strict schemas: length caps, `YYYY-MM-DD` dates, arrow values 0–10, and http/https-only URLs. The import schema accepts any `z.string()` or `z.number().int()` with no limits. That means:

- **Stored non-http URLs.** Link attachments (`url`) and `videoUrl` accept `javascript:` and `data:` URLs. The server comment at `tracker.ts:75` promises "a stored URL can never become an XSS vector", but import breaks that promise. Attachments are shown to the **coach**, so this crosses a privilege boundary. Only the frontend's `SafeLink` (`App.tsx:86-99`) stops it now, so one careless `<a href>` in future UI would be exploitable.
- **Unbounded sizes.** There are no string or array caps, so one request can write very large rows or row counts. The only limit is the Worker's request-body limit.
- **Invalid domain data.** Malformed dates, negative arrows, scores over 300, `weekNumber` outside 1–6, arbitrary `sightMarksJson`, and `kind: "document"` rows with no blob.
- **Duplicate keys.** Two rows with the same `dayKey`, `weekNumber` or check `key` cause a primary-key violation, and the batch fails with a 500.

**Fix:** Build the import schema from the same exported field schemas as the write endpoints (`sessionInput`, `httpUrl`, `dateInput`, and so on). Add `.max()` to every array, reject duplicate keys before writing, and restrict imported attachments to `kind: "link"`.

### H3. Import is not safely atomic
**Where:** `src/routes/export.ts:184-215`, `:319-365`

1. **R2 files are deleted before the D1 batch** (`:328`). If the batch then fails (duplicate keys from H2, ID collision below, D1 statement or size limits), the user's data is unchanged but **every uploaded file is permanently gone**, and the attachment rows now point to missing blobs.
2. **IDs are pre-assigned from `max(id)` across all users** (`:185-215`). A concurrent insert by any other user between the `max()` read and the batch takes an ID the import has already allocated. The result is a PK collision and a failed import, which combined with point 1 means data loss.
3. `practiceScoreEnds` that point to unknown `scoreId`s are silently dropped instead of rejected.

**Fix:** Don't pre-assign IDs. Insert parents with `RETURNING id` and map children from that, or keep a per-import temporary mapping keyed on natural keys. Delete R2 blobs only **after** the batch succeeds. Better still, keep blobs that are still referenced and delete only orphans in a background step. Check D1's per-batch statement and size limits for large exports.

### H4. File uploads: no quota, no type allowlist, expensive decode
**Where:** `src/routes/tracker.ts:87-97`, `:428-447`; `coach.ts:362`

- Any athlete can upload an unlimited number of 8 MB files to R2, and a coach can upload into every athlete's account. There's no per-user file or byte cap and no rate limit, so storage and cost abuse is possible.
- `mimeType` is any `type/subtype`. Downloads use `Content-Disposition: attachment` with `nosniff`, which is good, but nothing stops an `.exe` or `text/html` file from being stored and served. Use an allowlist such as images, PDF and common office formats.
- Upload is base64 inside JSON. A 12 MB JSON string is parsed, then decoded with `atob` and `Uint8Array.from(binary, cb)` (one callback per byte), so the file sits in memory about three times over and uses a lot of CPU. This can hit Workers CPU and memory limits well below 8 MB.

**Fix:** Accept `multipart/form-data` or raw body streaming straight to `R2.put`, or issue presigned R2 upload URLs. Enforce `Content-Length`, per-user quotas and a MIME allowlist, and rate-limit uploads.

### H5. CSRF: `SameSite=Lax` is the only defense
**Where:** `src/lib/auth.ts:101-106`, all mutating routes, `readJsonBody` (`tracker.ts:17`)

Hono's `c.req.json()` parses the body whatever its `Content-Type`, so a `<form enctype="text/plain">` can produce a valid JSON body. `SameSite=Lax` blocks that cross-site, but **not from same-site origins**. On a custom domain that means any sibling subdomain, for example a compromised `blog.example.com` against `app.example.com`, can make state-changing requests: import (which wipes data), delete, creating invites, and so on.

**Fix:** Add `hono/csrf` (Origin/`Sec-Fetch-Site` check) to all non-GET `/api/*` routes, and reject bodies that aren't `application/json`. Consider `SameSite=Strict`, since the app has no cross-site entry flows that need the cookie.

---

## Medium

### M1. No security headers
Neither the Worker responses nor the static assets set `Content-Security-Policy`, `frame-ancestors`/`X-Frame-Options` (clickjacking), `Strict-Transport-Security`, `Referrer-Policy` or `Permissions-Policy`. Static files are served directly by Workers Static Assets, so add a `frontend/public/_headers` file. Use a middleware for `/api/*`. A strict CSP (`default-src 'self'; frame-src https://www.youtube.com https://player.vimeo.com; object-src 'none'; base-uri 'none'`) would also back up the `SafeLink` defense from H2.

`Referrer-Policy: no-referrer` matters for `/invite/<token>` URLs. The token is a bearer credential in the URL path, and it also ends up in edge and access logs. Consider moving it to the URL fragment (`/invite#<token>`) so it never reaches the server in the request line.

### M2. Brute-force protection is weak
**Where:** `src/lib/rate-limit.ts`, `auth.ts:123`

- The login limit is **per IP only** (20 per 10 minutes). A distributed attack against one username isn't limited. Add a per-username key as well, for example `login-user:<lower(username)>`.
- `checkRateLimit` reads and then writes, with no atomicity, so concurrent requests all see the same count and get through. Use a single `INSERT ... ON CONFLICT DO UPDATE SET attempts = attempts + 1 ... RETURNING attempts`.
- Every call runs `DELETE FROM rate_limits WHERE window_start < ?` with no index on `window_start`, which is a full scan and a write on every login. Move cleanup to a Cron Trigger. Better, use the native Workers Rate Limiting binding.
- The `X-Forwarded-For` fallback is client-controlled. It's harmless behind Cloudflare, where `CF-Connecting-IP` is always set, but it's misleading, so remove it.

### M3. Account and session lifecycle is missing
There's no password change, password reset, "log out everywhere", account deletion, removing an athlete from a team, or athlete leaving a team. Consequences:

- A forgotten password means a permanent lockout unless someone edits D1 by hand.
- A compromised session can't be revoked by the user.
- A coach keeps plan access to an athlete forever.
- There's no way to meet data-deletion requests.

Expired `sessions` rows and used or expired `invites` are never purged. Plan a password-change flow (which revokes other sessions), a coach-initiated athlete removal, an admin reset path, and a scheduled cleanup job.

Related architecture limit: the **system supports exactly one coach**, because bootstrap works only with zero users and invites only create athletes. The README's "multi-user … coaches" framing should say this, or add coach invites.

### M4. Coach overview relies on filtering a full private payload
**Where:** `src/routes/coach.ts:310-319`

`getTrackerPayload` loads **all** of the athlete's private rows (sessions, scores, notes, setups, inspiration) and the route then picks five fields. The privacy guarantee depends on that pick staying correct through every future refactor. For example, `return c.json(payload)` or adding a field to `plannedSessions` would leak private logs. Split the function so the coach path only ever **queries** plan and aggregate tables. An aggregate query (`SUM(arrows) GROUP BY week`) is also cheaper.

### M5. File attachments can't be opened from the UI
**Where:** `frontend/src/App.tsx:86-99`, `:514`

The server returns file attachment URLs as the relative path `/api/plan/attachments/<id>/file` (`tracker.ts:274`). `safeHttpUrl` calls `new URL(value)` with no base, which throws for relative URLs. It then returns `null`, so the "Open" link never renders for documents or photos. Use `new URL(value, window.location.origin)` and allow same-origin paths.

### M6. Internal error messages returned to clients
**Where:** `tracker.ts:698`, `coach.ts:372`

Upload failures return `error.message` straight to the client. That message can be a D1 or R2 internal error. Return a generic message and log the details. Throw typed errors (for example `class UserFacingError`) for the messages that are meant to be shown, such as "larger than 8 MB".

---

## Architecture

### A1. No tests, CI or lint
There are no unit or integration tests, and no CI config. C1 and M5 would each have been caught by one smoke test. Recommended setup:

- **Framework:** `vitest` with `@cloudflare/vitest-pool-workers`, which gives real D1 and R2 in tests.
- **Auth tests:** bootstrap, login, invite accept (including races and expiry), logout.
- **RBAC tests:** a coach can't read another team's athlete, a coach can't see private logs, an athlete can't reach `/api/coach/*`, and cross-user attachment download is refused.
- **Import/export:** a round-trip test.
- **CI:** a GitHub Action running `typecheck`, `test` and `build`.

### A2. Schema is defined twice, by hand, and has already drifted
`src/db/schema.ts` and `migrations/0001_init.sql` are both hand-written. The case-insensitive unique index `users_username_ci_unique` and every `idx_*` index exist only in SQL. Generate migrations with `drizzle-kit generate` from `schema.ts`, and declare the indexes in Drizzle, so there's a single source of truth.

### A3. No referential integrity
None of the `user_id` or `coach_id` columns have foreign keys to `users`, and nothing cascades. Deleting a user (M3) would leave orphans in 14 tables, and the database can't catch an athlete whose `coach_id` points to nothing. Add FKs with `ON DELETE CASCADE` in the next migration. D1 enforces foreign keys.

### A4. Module structure
- `routes/tracker.ts` (824 lines) mixes Zod schemas, date utilities, domain logic, attachment and R2 handling, and HTTP routes. `auth.ts` and `export.ts` import HTTP helpers and enums **from a route file**. Suggested layout: `lib/validation.ts`, `lib/dates.ts`, `services/*.ts` (domain functions that take `db` and `userId`), with `routes/*` kept thin.
- The "read body, parse, return 400 on error" block is copied about 25 times. Use `@hono/zod-validator`. `parsePositiveInt` is duplicated in two files.
- `frontend/src/App.tsx` is a single 1,210-line component file. Split it by tab or feature.

### A5. Tracker payload scales with the user's full history
`getTrackerPayload` runs 13 queries on every dashboard load. It loads **all** training sessions and **all** practice-score ends, even though it returns only the latest 100 scores. It then computes weekly and cycle aggregates in JavaScript. Cost grows linearly with history. Push aggregation into SQL, limit the ends query to the returned score IDs, and paginate history.

The auth middleware also makes two sequential queries per request (session, then user). Use one join.

### A6. Mutations report success when nothing happened
`updateSessionFor`, `deleteSessionFor`, `deletePracticeScoreFor`, `updateMaintenanceItemFor`, `deleteMaintenanceItemFor` and `saveSetupFor` (with an `id`) return `{ ok: true }` even when no row matched, for example a wrong ID or someone else's row. Check `meta.changes` and return 404. That makes client bugs visible and makes RBAC tests meaningful.

### A7. Multi-statement writes that aren't atomic
- `addPracticeScoreFor` (`tracker.ts:377`) runs two separate inserts. If the second fails, a score is left with no ends.
- `clearMaintenanceSectionFor` runs N sequential upserts.
- `addMaintenanceItemFor` computes `sortOrder` with a count followed by an insert, which is racy.

Use `db.batch()` for these.

### A8. Leftovers from the single-user reference implementation
- New users get a hard-coded program state (`poundage 24, cycle 2, week 6`, at `tracker.ts:225` and `:489`), so every new athlete starts mid-program.
- Default weekly plans (`plannedSessionDefaults`) and bundled SPT workout images are one person's program.
- The `entries` table is unused but still exported and imported.

Decide what a new account should start with, and remove the dead table.

### A9. Timestamps are stored in two different ways
Some columns are raw epoch-ms integers (`expires_at`, `window_start`) and others use Drizzle `timestamp_ms` `Date` mapping. Business dates are UTC `YYYY-MM-DD` strings computed partly from a client-supplied `today`. It works, but it's easy to get wrong. Document the convention in one place.

### A10. Download filename encoding
`Content-Disposition: attachment; filename="${encodeURIComponent(label)}"` (`tracker.ts:724`) shows percent-escapes in the saved filename. Use `filename="<ascii-safe>"; filename*=UTF-8''<encoded>`.

### A11. Repo hygiene
- There is **no `.gitignore`**. `node_modules/`, `dist/`, `.wrangler/` (local D1 state with real user data and password hashes) and `.DS_Store` would all be committed by the first `git add .`. Add one before the first commit.
- `.DS_Store` and `.awman/` (agent tooling) are in the working tree. Remove them or ignore them.
- `wrangler.toml` still has the placeholder `database_id`, which is expected, but a deploy fails with an unclear error until it's set.

### A12. Service worker details (low)
Cache-first `/assets/*` entries are never pruned within `dga-shell-v1`, so the cache grows with every deploy until the cache name changes. Bump `CACHE_NAME` per build, for example by injecting the build hash, or prune entries that aren't in the current manifest.

---

## What's done well
- PBKDF2 with a random salt and constant-time comparison. Login avoids username enumeration by timing, because the unknown-user path still does one KDF call.
- Session and invite tokens are 256-bit random values and stored only as SHA-256 hashes. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS.
- Every tracker query is scoped by `user_id`. Coach routes all go through `resolveAthlete`, which checks role and team membership.
- Attachment downloads check ownership or coach membership and are served with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`.
- Link URLs are restricted to http/https on the normal write path, and the frontend has an extra check (`SafeLink`) as well.
- No raw string SQL concatenation. All SQL uses Drizzle or tagged `sql` templates.

## Suggested order of work
1. **C1, C2**: make signup and login work in production, and add the first integration tests (A1).
2. **H1, H5, A11**: close the bootstrap takeover window, add CSRF/Origin checks, add `.gitignore`.
3. **H2, H3**: harden import (shared schemas, safe ordering, no pre-assigned IDs).
4. **H4, M1, M2**: upload quotas and streaming, security headers, better rate limiting.
5. **M3, M4, M5**: account lifecycle, split the coach payload, fix attachment links.
6. Remaining architecture items as ongoing cleanup.

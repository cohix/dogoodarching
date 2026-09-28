# Work Item: Task

Title: Security hardening from the 2026-09-26 architecture & security review
Issue: TBD

## Summary:
- Fix the security findings in `REVIEW.md`: C2, H2–H5, M1–M4 and M6.
- **Out of scope:** H1, the public first-user bootstrap / fresh-deploy takeover window. It's accepted for now; leave `POST /api/auth/bootstrap` as it is.
- C2 is a production blocker (password hashing throws on hosted Workers), so do it first within this item. Signup and login on the hosted preview and production environments stay broken until this lands.
- Starts after work item 0001 (architecture). It depends on 0001's test harness (A1), module layout (§4), preview environment (§2) and shared coaching team model (§13).

### Decisions (confirmed with the product owner, 2026-09-28)
- **Rate limiting:** use the Cloudflare Workers Rate Limiting binding. Drop the D1 `rate_limits` table and the D1 limiter (§6).
- **Upload quota:** 100 files and 500 MB per athlete, 8 MB per file. Coach uploads count against the athlete (§3).
- **Removing an athlete:** any coach can deactivate an athlete. Deactivation disables login and hides the athlete from the team; their data is kept, and a coach can reactivate them (§7).
- **Ownership:** the owner can transfer ownership to another coach. The owner can't delete their account until they've transferred it (§7).
- **Coach account deletion:** athletes belong to the whole team, so deleting a coach doesn't affect any athlete. The last remaining coach can't delete their account (§7).
- **Password hashing:** C2 stays in this item and isn't moved into 0001.

## User Stories

### User Story 1:
As a: user (athlete or coach)

I want to:
sign up and log in on the production deployment

So I can:
use the app at all (right now PBKDF2 at 210k iterations is above the hosted Workers limit)

### User Story 2:
As a: coach

I want to:
be sure athlete-supplied data (imports, links, uploads) can't be used to attack my session or read an athlete's private logs

So I can:
open my athletes' plans and attachments safely

### User Story 3:
As a: user

I want to:
change my password, sign out of all devices, and have my account and data deleted

So I can:
recover from a compromised or forgotten credential and control my data

### User Story 4:
As a: coach

I want to:
deactivate an athlete who has left the club, and reactivate them if they come back

So I can:
keep the team list current and stop former athletes signing in, without losing their history

### User Story 5:
As a: owner

I want to:
hand ownership to another coach

So I can:
step down or delete my account without leaving the team without an owner

### User Story 6:
As a: operator

I want to:
keep storage use, brute-force attempts and cross-site request forgery under control

So I can:
run the app without runaway R2 costs or account compromise

## Implementation Details:

### 1. PBKDF2 iteration count (C2): `src/lib/auth.ts`
- Lower `PBKDF2_ITERATIONS` to 100,000, the hosted Workers maximum.
- Make `verifyPassword` read the iteration count from the stored hash (`pbkdf2$<n>$salt$hash`) instead of requiring it to equal the constant. Reject `n` values that are non-numeric, below a floor, or above 100,000.
- On successful login, if the stored count differs from the current constant, rehash and update `password_hash`. This allows future tuning without lockouts.

### 2. Import hardening (H2 + H3): `src/routes/export.ts`
- Build `importPayloadSchema` from the same field schemas the write endpoints use. Import them from `src/lib/validation.ts`, set up by 0001's restructure. Specifically:
  - `dateInput` for every `YYYY-MM-DD` field
  - `httpUrl` for link attachment `url` and `videoUrl`
  - the same `.max()` string lengths, arrow values 0–10, `weekNumber` 1–6, and poundage and duration ranges
  - `sightMarksJson` must parse to `Record<string,string>`
- Add `.max()` caps to every array. Choose limits generous enough for real exports, for example 20k sessions and 5k scores, and document them.
- Allow only `kind: "link"` for imported attachments.
- Before writing anything, reject duplicate natural keys: `dayKey` (overrides), `weekNumber`, milestone/maintenance `key`, and `weekStart`. Also reject score ends whose `scoreId` isn't in the payload; don't silently drop them.
- Remove the global `max(id)` pre-assignment. Let AUTOINCREMENT assign IDs, and resolve parent→child relationships (score→ends, maintenance item→`item:<id>` check keys) another way. Options:
  - two phases: insert parents with `RETURNING id`, then children
  - a batch that uses `last_insert_rowid()`-free natural keys
- Delete R2 blobs of replaced file attachments **only after** the D1 batch succeeds. If deletion then fails, log it and continue; orphaned blobs are acceptable, lost files are not.
- Check the batch against D1 statement-count and size limits. Return a clear 413/400 if the payload is too large instead of a 500.

### 3. File uploads (H4): `src/routes/tracker.ts` (`plannedSessionFileInput`, `addPlannedSessionFileFor`), `src/routes/coach.ts`, `frontend/src/api.ts` and the plan UI
- Replace base64-in-JSON with `multipart/form-data`, or a raw body with metadata in headers or query. Stream straight into `ATTACHMENTS.put`.
- Enforce `Content-Length` of 8 MB or less before reading the body.
- Add a MIME allowlist: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`, and common office document types. Serve other stored types as `application/octet-stream`.
- Add per-athlete quotas of **100 files and 500 MB**, counted over the **target** user so coach uploads count against the athlete. Keep the 8 MB per-file limit. Return 413 with a clear message saying which limit was hit.
- Store each attachment's byte size (new `size_bytes` column) so the quota check is one `SUM`/`COUNT` query. Backfill existing rows from R2 `head()` in the migration script or a one-off job.
- Add an upload rate limit keyed on the acting user, using the §6 binding.

### 4. CSRF (H5): `src/index.ts`, `src/lib/auth.ts`
- Apply `hono/csrf` (Origin / `Sec-Fetch-Site` check) to all non-GET/HEAD `/api/*` routes.
- Change `readJsonBody` to reject requests whose `Content-Type` isn't `application/json` (415).
- Switch the session cookie to `SameSite=Strict` unless a flow needs Lax. Invite links don't, because they don't rely on an existing session.

### 5. Security headers (M1)
- Add `frontend/public/_headers` for static assets with:
  - `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; frame-src https://www.youtube.com https://player.vimeo.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
  - `Referrer-Policy: no-referrer`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`
  - `Permissions-Policy` with unused features disabled
- Add equivalent headers to `/api/*` responses with a Hono middleware (`hono/secure-headers`).
- Check that the built SPA works under the CSP (Vite output, the service worker, YouTube/Vimeo embeds).
- Move the invite token from the path to the fragment (`/invite#<token>`), so it stays out of request lines, edge logs and Referer. Update `invitePath` in `auth.ts`, `inviteTokenFromPath` in `App.tsx`, and the service worker comment. Keep the `/invite/<token>` form working for invites issued before the change, and have it immediately `replaceState` away.

### 6. Brute-force and rate limiting (M2): `src/lib/rate-limit.ts`, `src/routes/auth.ts`
- Replace the D1 limiter with the Workers Rate Limiting binding. Declare `[[ratelimits]]` namespaces in `wrangler.toml` for both production and `[env.preview]`, and add the bindings to `Env`.
- The binding only supports 10- or 60-second periods, so the old "20 per 10 minutes" limits become per-minute limits. Starting values, to be tuned:
  - login per IP: 10/min
  - login per username (`login-user:<lower(username)>`): 5/min
  - accept-invite per IP: 10/min
  - bootstrap per IP: 5/min
  - invite creation per coach: 10/min
  - uploads per acting user: 10/min
- Keep `rateLimitOr429` as the single helper so routes don't call the binding directly.
- The binding is approximate and counts per Cloudflare location. Document this in `aspec/architecture/security.md`; it's acceptable for this app.
- Drop the `rate_limits` table and its schema definition in this item's migration.
- Remove the `X-Forwarded-For` fallback in `clientIp`.

### 7. Account and session lifecycle (M3): new endpoints in `src/routes/auth.ts` / `coach.ts`, plus Settings and Team UI
- `POST /api/auth/password`: requires the current password. It updates the hash and deletes all of the user's other sessions.
- `POST /api/auth/logout-all`: deletes all of the user's sessions.
- `DELETE /api/auth/account`: requires the password. It deletes all of the user's rows and R2 blobs. Rules:
  - The owner gets 409 with "Transfer ownership before deleting your account".
  - The last active coach gets 409 as well. This follows from the owner rule, but check it explicitly.
  - Deleting a (non-owner) coach doesn't touch any athlete. The §3 FK in 0001 sets `invited_by` to NULL on users they invited, and their pending invites are deleted.
  - Coach-uploaded files live on the athlete's plan and are kept.
- **Athlete deactivation**, available to any coach:
  - Add `users.deactivated_at` (nullable timestamp).
  - `POST /api/coach/athletes/:athleteId/deactivate` sets it and deletes all of that athlete's sessions.
  - `POST /api/coach/athletes/:athleteId/reactivate` clears it.
  - `authMiddleware` rejects deactivated users (401). Login for a deactivated user returns the same generic "Invalid username or password" message so account state doesn't leak.
  - `GET /api/coach/athletes` excludes deactivated athletes by default; `?include=deactivated` includes them, flagged, so they can be reactivated. Coach plan endpoints keep working for deactivated athletes, so history stays viewable.
  - A deactivated athlete's username stays reserved.
- **Ownership transfer:** `POST /api/auth/owner/transfer` with `{ coachId, password }`.
  - Only the owner can call it. The target must be an active coach.
  - Moving `is_owner` is one `db.batch([...])` (clear on the current owner, set on the target), and must stay compatible with 0001's partial unique index. Clear first, then set, in the same batch.
  - Pending coach invites created by the old owner become invalid automatically (0001 §13 validity rule).
- **UI:**
  - Settings: change password, sign out everywhere, delete account. Show the owner a "Transfer ownership" picker instead of delete.
  - Team tab: Deactivate/Reactivate per athlete, and a "Show deactivated" toggle.
- Scheduled cleanup: add a Cron Trigger (production and preview) that deletes expired `sessions` and invites that have been used or expired for more than 30 days.
- Password reset without email isn't required here. Document the manual admin reset procedure (a `wrangler d1 execute` snippet) in the README and `aspec/devops/operations.md`.

### 8. Coach overview privacy (M4): `src/routes/coach.ts:304`, `src/routes/tracker.ts`
- Add a dedicated `getCoachOverviewFor(db, athleteId, today)` that only **queries** program state, cycle week plans, planned session overrides, attachments, and SQL aggregates of arrows per week and session dates. It must never select `notes`, `focus`, `score` or other private columns.
- Change the coach route to use it. Stop calling `getTrackerPayload` from coach code.

### 9. Error leakage (M6): `tracker.ts:698`, `coach.ts:372`
- Add a `UserFacingError` class. Only its messages are returned to clients; everything else gets a generic "Upload failed" and is logged with `console.error`.

## Edge Case Considerations:
- PBKDF2: existing hashes at 210k (only possible from local dev databases) must still verify locally and be rehashed on login. Hosted Workers can't verify them at all, so document that local dev databases created before this change may need their users recreated.
- Import:
  - A payload exported before this change may contain invalid dates, oversized strings or `javascript:` URLs. Reject it with an error that names the field and index, not a generic 400.
  - An empty payload must still clear the user's data.
  - An import that fails at any point must leave both D1 rows and R2 blobs unchanged.
- Uploads:
  - a missing or lying `Content-Length`
  - a stream that ends early
  - an R2 put that succeeds followed by a failed D1 insert (the blob must be cleaned up)
  - a coach uploading into an athlete who is at quota
- CSRF: requests without an `Origin` header, such as older iOS PWA contexts. Verify that installed PWAs on iOS and Android still work. `Sec-Fetch-Site: same-origin` must pass.
- CSP: the YouTube `youtube-nocookie.com` host, Vimeo, and inline styles, if Tailwind or React output needs `style-src 'unsafe-inline'`.
- Invite fragment: old path-style links, and fragments that the SPA router or service worker navigation handling strips.
- Password change: the current session must stay valid while all others are revoked.
- Account deletion:
  - the owner, and the last remaining coach, are refused
  - a non-owner coach who invited athletes is deleted, and those athletes are unaffected
  - deletion while an upload is in progress
  - partial R2 deletion failure (retry via the cleanup job)
- Deactivation:
  - a deactivated athlete with an open session is signed out on their next request
  - deactivating twice or reactivating an active athlete succeeds without changing anything (idempotent)
  - a coach tries to deactivate another coach: 404, because `resolveAthlete` only matches athletes
  - an import or upload request is already running when the athlete is deactivated
- Ownership transfer:
  - the target is an athlete, a deactivated user, the owner themself, or doesn't exist
  - two transfers run at the same time: the partial unique index must keep exactly one owner
- Rate limiting:
  - a per-username limit someone else could use to lock a user out: keep limits short and time-bounded
  - the binding counts per location, so limits are approximate
  - the binding isn't configured in local dev or tests: use a no-op or mock fallback, and never fail open in production

## Test Considerations:
- Integration tests (vitest + `@cloudflare/vitest-pool-workers`, real D1/R2):
  - Login with the new hash format. A legacy iteration count is upgraded on login.
  - Import:
    - rejects `javascript:` and `data:` URLs, bad dates, over-length strings, oversized arrays, duplicate keys and orphan ends
    - export→import round-trip keeps data
    - a failing import leaves D1 and R2 unchanged, including a forced batch failure
    - import doesn't touch other users' rows or IDs, even with concurrent inserts from another user
  - Upload:
    - rejects disallowed MIME types, oversize bodies and quota overflow
    - a coach upload counts against the athlete
  - CSRF:
    - POST with a cross-site `Origin` gets 403
    - POST with `text/plain` gets 415
    - a same-origin JSON POST succeeds
  - Headers: CSP and the other headers are present on `/` and `/api/*`.
  - Rate limit (mock the binding in tests):
    - `rateLimitOr429` returns 429 when the binding denies the request
    - login checks both the per-IP and per-username keys
    - the `rate_limits` table no longer exists after migrations
  - Lifecycle:
    - password change revokes other sessions
    - logout-all works
    - account deletion removes every user-scoped row and blob
    - a deactivated athlete can't log in or use an existing session, is hidden from the default team list, can be reactivated, and keeps their data
    - owner deletion is refused before transfer and allowed after it
    - last-coach deletion is refused
    - deleting a coach leaves every athlete unchanged
    - after a transfer there is exactly one owner and `/api/auth/me` reflects it
  - Upload quota: the 101st file and the upload that would pass 500 MB are both rejected
  - Coach overview: the response body contains no session notes, focus, scores, weekly notes, setups or inspiration fields. Seed distinctive strings and assert they're absent.
  - Errors: a simulated R2 failure returns a generic message.
- Manual: on the preview environment from 0001, check signup, login, upload/download, rate limiting, deactivation and PWA install, since hosted-runtime limits differ from local `workerd`.

## Codebase Integration:
- follow established conventions, best practices, testing, and architecture patterns from the project's aspec.
- Put shared validation schemas in the module layout set up by work item 0001. Don't add more exports to `routes/tracker.ts`.
- Schema changes (indexes, any new columns) go in a new drizzle-kit generated migration (`migrations/0003_*` or later, after 0001's `0002_*`). Never edit `0001_init.sql`.
- Update `README.md`: API overview (new endpoints), roles table (deactivation, ownership transfer), import limits, upload quotas, admin password reset procedure.
- Update the matching `aspec/` files filled in by 0001: security, experience, operations, infrastructure (Rate Limiting binding, Cron Trigger), and apis. Turn this item's `Planned (work item 0002):` notes into current behaviour.

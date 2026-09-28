# Work Item: Task

Title: Security hardening from the 2026-09-26 architecture & security review
Issue: TBD

## Summary:
- Fix the security findings in `REVIEW.md`: C2, H2–H5, M1–M4 and M6.
- **Out of scope:** H1, the public first-user bootstrap / fresh-deploy takeover window. Keep bootstrap public and retain 0001's atomic first-owner creation; shared hashing, CSRF and rate-limit changes in this item still apply to that endpoint.
- C2 is a production blocker (password hashing throws on hosted Workers), so do it first within this item. Signup and login on the hosted preview and production environments stay broken until this lands.
- Work item 0001 is complete in commit `9e25222`. Build on its test harness, service modules, preview configuration and shared coaching team model. This item remains unimplemented; review/update of this specification does not mark the security work complete.

### Post-0001 review (2026-09-28)
- All listed findings still have remaining work. M2 is partly addressed: the current D1 limiter already uses an atomic conditional upsert and no longer scans for expired keys on each request. Its replacement, username/upload limits and forwarded-IP removal remain here.
- Current implementation locations: auth persistence in `src/services/auth.ts`; import/export in `src/routes/transfer.ts` and `src/services/transfer.ts`; upload/download logic in `src/services/attachments.ts`; coach overview in `src/services/dashboard.ts`; team queries in `src/services/team.ts`; schemas in `src/lib/validation.ts`; HTTP validation in `src/lib/http.ts`.
- Reuse `validateJson`, `rateLimit` and `getCoachOverview`. The old `readJsonBody`, `rateLimitOr429` and `src/routes/export.ts` do not exist. Keep routes thin.
- Tests use Vitest 4 and `@cloudflare/vitest-plugin`, with Worker/D1/R2, frontend/jsdom and build projects. Extend the existing suites and helpers rather than installing the older pool package named in the original plan.
- Preserve 0001's nullable poundage, version-1 export compatibility (including ignored legacy `entries`), 24-hour single-use invites, shared-team access and epoch-ms `timestamp_ms` columns. Applied migrations end at `0002_team_auth.sql`.
- The manual password reset runbook already exists in `aspec/devops/operations.md`; update and verify it with the new hash parameters.
- Resolve the earlier contradictory directions below by keeping import replacement in one atomic D1 batch, handling unsupported 210k hashes through operator reset, and retaining athlete invites after coach deletion as required by 0001 §13.

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
recover from a compromised credential and control my data (forgotten-password recovery remains an operator task)

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

### 1. PBKDF2 iteration count (C2): `src/lib/auth.ts`, `src/services/auth.ts`
- Lower `PBKDF2_ITERATIONS` to 100,000, the hosted Workers maximum.
- Make `verifyPassword` read the iteration count from the stored hash (`pbkdf2$<n>$salt$hash`) instead of requiring it to equal the constant. Define and document a minimum supported count; reject non-integers, malformed encodings, counts below that floor or above 100,000, salts other than 16 bytes and derived hashes other than 32 bytes. Invalid stored hashes must fail authentication without throwing or allowing zero-length comparisons.
- On successful login with a supported older count, rehash and update `password_hash`. Condition the update on the hash that was verified so a concurrent password change cannot be overwritten. Preserve comparable password-work costs for unknown/deactivated users and wrong passwords.
- Use the same supported-count rules locally and remotely. Existing 210k hashes need the documented operator reset to a new 100k hash; do not require a local-only 210k login exception. Keep data and ownership intact during reset and revoke old sessions.
- Verify real hosted bootstrap, invite acceptance and login. The upstream proposal to raise the default cap is still open at review time and is not evidence of a hosted rollout: [workerd #7550](https://github.com/cloudflare/workerd/pull/7550).

### 2. Import hardening (H2 + H3): `src/lib/validation.ts`, `src/services/transfer.ts`, `src/routes/transfer.ts`
- Build `importPayloadSchema` from the same field schemas the write endpoints use. Import them from `src/lib/validation.ts`, set up by 0001's restructure. Specifically:
  - `dateInput` for every `YYYY-MM-DD` field; strengthen its current regex to reject impossible dates, and reuse it in normal session/score writes and `today` queries too
  - `httpUrl` for link attachment `url` and `videoUrl`
  - the same `.max()` string lengths, arrow values 0–10, `weekNumber` 1–6, and poundage and duration ranges
  - `sightMarksJson` must parse to `Record<string,string>`
- Preserve `programState: null` and `currentPoundage: null` from 0001; validate cycle/week bounds and cap cycle values so an imported state cannot cause unbounded cycle-summary allocation. Require ten uniquely numbered ends (1–10) per practice score and recompute totals from arrows, or reject inconsistent supplied totals.
- Add `.max()` caps to every array. Choose limits generous enough for real exports, for example 20k sessions and 5k scores, and document them.
- Allow only `kind: "link"` for imported attachments.
- Before writing anything, reject duplicate natural keys: `dayKey` (overrides), `weekNumber`, milestone/maintenance `key`, and `weekStart`. Reject duplicate source IDs within each array, duplicate `(scoreId, endNumber)` pairs, orphan score ends and `item:<id>` checks whose maintenance item is absent. Preserve legacy non-ID maintenance check keys.
- Remove the global `max(id)` pre-assignment. Let AUTOINCREMENT assign IDs and resolve score→ends and maintenance item→check relationships inside the **same** D1 batch as replacement. Use a per-import mapping/staging design with unique import/source keys if necessary; dates and labels are not unique parent identifiers. Separate awaited parent and child writes are not atomic and are not an acceptable implementation. Never use `db.transaction()` or assume connection-local temporary state persists across calls.
- Record R2 keys for the rows actually replaced in that same batch, then delete blobs **only after** it succeeds. Use the durable cleanup mechanism in §7 if deletion fails, log the failure and still return import success. A pre-read of keys alone can miss a concurrent coach upload; account for concurrent attachment changes without deleting a still-referenced file.
- Keep 0001's parameter-aware insert chunking (at most 100 bound parameters per statement). Add an overall request-byte cap before JSON parsing, per-array caps and a preflight check of the generated batch against the deployed plan's query budget, statement length and value sizes. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/). The example row caps above are not a promise that every combination fits: document the effective limits and return a clear 413/400 before destructive writes. Do not split the replacement across independently committed batches to fit limits.

### 3. File uploads (H4): `src/services/attachments.ts`, `src/lib/validation.ts`, tracker/coach routes, `frontend/src/api.ts` and `frontend/src/features/plan/`
- Replace base64-in-JSON with a raw file body and validated metadata in headers/query, or genuinely streaming multipart parsing. Do not replace base64 decoding with whole-file buffering through `formData()`/`arrayBuffer()`. Update the shared frontend fetch helper so uploads do not inherit its unconditional JSON content type.
- Retain the existing decimal 8 MB limit (8,000,000 file bytes). Reject a declared oversize `Content-Length` before reading; also count actual streamed bytes, enforce the cap, and reject truncated/mismatched bodies. Define the missing-length path and verify the chosen transport with browser `File` uploads and R2's stream-length requirements. For multipart, bound metadata/overhead separately from the file size; browser code must not try to set `Content-Length` itself.
- Add a MIME allowlist: `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `application/pdf`, and common office document types. Serve other stored types as `application/octet-stream`.
- Enumerate the exact allowed office MIME types in one shared constant. Normalize MIME metadata before validation, and use the safe effective MIME type for both download headers and 0001's filename builder.
- Add per-target-user quotas of **100 files and 500 MB (500,000,000 bytes)**, excluding links. Personal uploads by either role use their own quota; coach uploads use the athlete's quota. Return 413 with a clear message saying which limit was hit. Enforce admission atomically with a reservation or conditional write; a standalone `SUM`/`COUNT` precheck cannot prevent concurrent over-quota uploads. Release failed reservations and clean up blobs whose D1 commit fails.
- Store each attachment's byte size (new `size_bytes` column). SQL migrations cannot call R2: provide an idempotent, resumable backfill job using `head()`, with an explicit policy for missing blobs/unknown sizes and existing users above quota. Unknown sizes must not count as zero. Document rollout ordering so old code cannot create uncounted uploads between backfill and enforcement; block further uploads until a target's accounting is complete.
- Add an upload rate limit keyed on the acting user, using the §6 binding.

### 4. CSRF (H5): `src/index.ts`, `src/lib/http.ts`, `src/lib/auth.ts`
- Enforce same-origin checks on all unsafe `/api/*` requests, including JSON, raw uploads and bodyless logout/delete; exempt GET/HEAD/OPTIONS. The [Hono CSRF middleware](https://hono.dev/docs/middleware/builtin/csrf) only checks form-compatible content types, so mounting it alone does not meet this requirement. Add an explicit guard for full coverage.
- Reject a present mismatching or `null` Origin with 403; otherwise accept an exact same-origin Origin, or a missing Origin with `Sec-Fetch-Site: same-origin`. Reject requests with neither proof. Same-site sibling origins are not same-origin. If a supported PWA lacks both headers, add a verified CSRF-token flow rather than failing open. Keep errors in `{ error: string }` form.
- Change `validateJson` to reject missing/non-JSON `Content-Type` with 415 **before parsing**, accepting `application/json` with an optional charset. Apply this only to JSON endpoints; upload routes use their own content-type validation and bodyless endpoints remain usable. Malformed JSON remains 400.
- Switch the session cookie to `SameSite=Strict` unless a flow needs Lax. Invite links don't, because they don't rely on an existing session.

### 5. Security headers (M1)
- Add `frontend/public/_headers` for static assets with:
  - `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
  - `Referrer-Policy: no-referrer`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `X-Content-Type-Options: nosniff`
  - `Permissions-Policy` with unused features disabled
- Add equivalent headers to `/api/*` responses with a Hono middleware (`hono/secure-headers`).
- Check that the built SPA works under the CSP (Vite output, the service worker, YouTube/Vimeo embeds, React inline styles and Recharts). Add the narrow style allowances needed without relaxing script restrictions. API headers must also cover errors and direct `Response` downloads. Verify static headers through Workers Static Assets; an API-only test cannot cover `/`.
- Move the invite token from the path to the fragment (`/invite#<token>`), so new links keep it out of request lines, edge logs and Referer. Update `invitePath` in `src/routes/auth.ts`, `inviteTokenFromPath` in `frontend/src/App.tsx`, and the comment in `frontend/sw.js` (built by `scripts/service-worker-cache.mjs`). Keep `/invite/<token>` working and immediately use `replaceState` to remove the token after capturing it for acceptance. This cannot erase the initial server request for an old path link. Preserve 24-hour expiry and single-use semantics, including owner validation of coach invites.

### 6. Brute-force and rate limiting (M2): `src/lib/rate-limit.ts`, `src/routes/auth.ts`
- Replace the already-atomic D1 limiter with Workers Rate Limiting bindings. Declare `[[ratelimits]]` and `[[env.preview.ratelimits]]` in `wrangler.toml`, and bindings in `Env` (`src/db/index.ts`). Limits are fixed per binding: configure separate 5/min and 10/min bindings (or one per operation), choose by operation and prefix keys. Use distinct namespace IDs between preview and production so their counters cannot interfere. See [binding configuration](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).
- The binding only supports 10- or 60-second periods, so the old "20 per 10 minutes" limits become per-minute limits. Starting values, to be tuned:
  - login per IP: 10/min
  - login per username (`login-user:<lower(username)>`): 5/min
  - accept-invite per IP: 10/min
  - bootstrap per IP: 5/min
  - invite creation per coach: 10/min
  - uploads per acting user: 10/min
- Keep `rateLimit` as the shared middleware interface, adapting `checkRateLimit` behind it so routes do not call bindings directly. Keep IP checks before body parsing and add normalized-username checks after validation but before hashing; no username existence lookup is needed for the key. Add a short per-acting-user limit to password verification in the new password/delete/transfer endpoints too.
- The binding is approximate and counts per Cloudflare location. Document this in `aspec/architecture/security.md`; it's acceptable for this app.
- Drop the `rate_limits` table and its schema definition in this item's migration.
- Remove the `X-Forwarded-For` fallback in `clientIp`.

### 7. Account and session lifecycle (M3): auth/team services, `src/lib/rbac.ts`, auth/coach routes, Settings and Team features
- `POST /api/auth/password` with `{ currentPassword, newPassword }`: validate with shared password schemas, verify the current password, then atomically update the hash and delete all other sessions. Use `c.get("sessionId")` from 0001 to retain the current session; reject a stale password verification if another request changed the hash first.
- `POST /api/auth/logout-all`: deletes all of the user's sessions and clears the cookie. Logout-all/account deletion clear frontend account caches and return to the auth screen.
- `DELETE /api/auth/account` with `{ password }`: requires the password. Atomically delete the account/user-scoped rows and enqueue its blob keys for post-commit deletion. Clear the cookie immediately; attempt cleanup promptly and retry failures via the scheduled job. Never remove R2 files before the database commits. Rules:
  - The owner gets 409 with "Transfer ownership before deleting your account".
  - The last active coach gets 409 as well. This follows from the owner rule, but check it explicitly.
  - Deleting a (non-owner) coach doesn't delete or change any athlete's training data. The existing FKs set `users.invited_by` and `invites.created_by` to NULL. Preserve unexpired athlete invites, which stay usable after their creator's deletion under 0001 §13. Coach invites with no current-owner creator remain unusable; do not delete all pending athlete invites as the original 0002 draft proposed.
  - Coach-uploaded files live on the athlete's plan and are kept.
- **Athlete deactivation**, available to any coach:
  - Add `users.deactivated_at` (nullable `timestamp_ms`). Update the explicit-column invite-accept insert in `src/services/auth.ts` for the changed user schema; retain the batch's `changes() = 1` guard and concurrent-claim protection.
  - `POST /api/coach/athletes/:athleteId/deactivate` sets it and deletes all of that athlete's sessions in one batch.
  - `POST /api/coach/athletes/:athleteId/reactivate` clears it.
  - `authMiddleware` rejects deactivated users (401). Login for a deactivated user returns the same generic "Invalid username or password" message so account state doesn't leak.
  - `GET /api/coach/athletes` excludes deactivated athletes by default; `?include=deactivated` includes them, flagged, so they can be reactivated. Coach plan endpoints keep working for deactivated athletes, so history stays viewable.
  - A deactivated athlete's username stays reserved.
  - Guard session creation against login/deactivation races so reactivation cannot revive a session created after revocation. In-flight personal import/upload commits must recheck the actor's active state; coach writes to a deactivated athlete remain allowed under the plan-access rule. Account deletion must prevent any in-flight upload from leaving an untracked blob.
- **Ownership transfer:** `POST /api/auth/owner/transfer` with `{ coachId, password }`.
  - Only the owner can call it. The target must be an active coach.
  - Moving `is_owner` is one `db.batch([...])` (clear on the current owner, set on the target), compatible with 0001's partial unique index. Recheck caller ownership, verified password and target eligibility inside the batch. Clear only when a valid target exists, and condition the promotion on this batch actually clearing the caller. A zero-row second update does not automatically roll back D1: guarantee no path commits zero owners, and return a conflict for a stale concurrent transfer. The unique index guarantees **at most** one owner, not **exactly** one. Apply equally atomic ownership/last-coach guards to deletion.
  - Pending coach invites created by the old owner become invalid automatically (0001 §13 validity rule).
- **UI:**
  - Settings: change password, sign out everywhere, delete account. Show the owner a "Transfer ownership" picker instead of delete.
  - Team tab: Deactivate/Reactivate per athlete, and a "Show deactivated" toggle.
- Scheduled cleanup: add Cron Triggers (production and preview) and a `scheduled` handler in `src/index.ts` that delete expired `sessions` and invites used more than 30 days ago, or unused and expired more than 30 days ago. Document the chosen UTC schedule and process bounded batches.
- Add durable pending-blob cleanup records, written with the D1 operation that removes references, for import/account deletion and attachment deletion. The job retries R2 deletion idempotently, removes a record only after success, and never deletes a currently referenced key. Include abandoned upload reservations/blobs in recovery; logging or `waitUntil` alone is not a durable retry mechanism. Cleanup records must survive deletion of their user.
- Password reset without email isn't required here. Update the existing manual reset runbook in `aspec/devops/operations.md` for the supported hash format and session revocation, and link it from the README; verify it preserves account data and owner status.

### 8. Coach overview privacy (M4): `src/services/dashboard.ts`, `src/routes/coach.ts`
- Rewrite the existing `getCoachOverview(db, athleteId, today)` to only **query** program state, cycle week plans, planned session overrides, attachments, and SQL aggregates of arrows per week and distinct session dates. It must never select private log columns such as session `notes`, `focus` or `score`, or query private scores, weekly notes, gear, maintenance or inspiration tables.
- The coach route already calls this service; remove its internal call to `getTrackerPayload`. Reuse shared plan/aggregate helpers and retain 0001's bounded date ranges, null-poundage/default handling and the existing five-field response contract. Test query selection as well as the response body: a response-only test passes the current vulnerable implementation.

### 9. Error leakage (M6): `src/lib/http.ts`, `src/services/attachments.ts`, tracker/coach upload routes
- Add a shared `UserFacingError` class carrying an allowed public message and HTTP status. Only those messages are returned to clients; unexpected upload errors get a generic "Upload failed" with 500 and are logged with `console.error`. Expected validation/type/quota failures use 400/415/413, respectively, in the existing `{ error: string }` envelope. Extend `jsonError`'s current status union as needed. Do not log passwords, raw tokens or request bodies.

## Edge Case Considerations:
- PBKDF2: supported lower counts upgrade on login; 210k hashes fail safely in every environment and use the operator-reset path. Malformed or empty hash/salt fields must never authenticate or return 500.
- Import:
  - A payload exported before this change may contain invalid dates, oversized strings or `javascript:` URLs. Reject it with an error that names the field and index, not a generic 400.
  - A valid version-1 payload with empty arrays and null program state must still clear the user's data; `{}` remains invalid. Ignore legacy `entries`, and continue exporting only link attachments.
  - Validation or D1 failure must leave user data and referenced R2 blobs unchanged. After commit, a blob cleanup failure leaves a successful import with durable cleanup pending, rather than reporting that the committed import failed.
  - Concurrent imports and coach attachment mutations must not cause ID collisions, delete a still-referenced blob or lose cleanup keys.
- Uploads:
  - a missing or lying `Content-Length`
  - a stream that ends early
  - an R2 put that succeeds followed by a failed D1 insert (the blob must be cleaned up)
  - a coach uploading into an athlete who is at quota
  - two uploads competing for the final file/byte allowance; failed and abandoned reservations; unknown backfilled sizes and accounts already above quota
- CSRF: requests without an `Origin` header, such as older iOS PWA contexts. Verify that installed PWAs on iOS and Android still work. A missing Origin with `Sec-Fetch-Site: same-origin` must pass; a conflicting Origin must fail. Check the local Vite proxy as well as hosted same-origin requests.
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
  - two transfers, or transfer and target-account deletion, run at the same time: database guards plus the partial unique index must leave exactly one owner
- Rate limiting:
  - a per-username limit someone else could use to lock a user out: keep limits short and time-bounded
  - the binding counts per location, so limits are approximate
  - use explicit local/test binding mocks; a missing binding or binding error on preview/production returns a generic service error and never silently disables limits

## Test Considerations:
- Extend the existing Vitest + `@cloudflare/vitest-plugin` suites with real local D1/R2:
  - Bootstrap, invite acceptance and login with the existing stored format at the new count. A supported lower count upgrades on login; malformed and 210k hashes fail safely; rehash cannot overwrite a concurrent password change. Verify the reset runbook without deleting account data.
  - Import:
    - rejects `javascript:` and `data:` URLs, impossible dates, over-length strings, oversized arrays/requests/batches, duplicate IDs/keys, orphan ends/checks and inconsistent score totals
    - export→import round-trip keeps supported data, null poundage and legacy `entries` compatibility; a valid empty import clears data
    - a forced failure late in the D1 batch restores all user rows and leaves referenced R2 blobs intact; post-commit R2 failure returns success and creates retryable cleanup
    - import doesn't touch other users' rows or IDs, even with concurrent inserts from another user
  - Upload:
    - rejects disallowed MIME types, oversize bodies and quota overflow
    - a coach upload counts against the athlete; concurrent boundary uploads cannot exceed quotas
    - missing/false lengths, truncated streams, failed D1 commits and interrupted uploads do not bypass size limits or leave permanent untracked blobs/reservations
  - CSRF:
    - unsafe requests with cross-site/sibling-site/`null` Origin get 403 for JSON, upload and bodyless endpoints
    - same-origin JSON endpoints with `text/plain` or missing content type get 415, malformed JSON gets 400, and valid JSON with charset succeeds
    - absent Origin plus same-origin Fetch Metadata succeeds; absent proof or conflicting Origin fails; error bodies remain JSON
  - Headers: CSP and the other headers cover `/api/*`, including failures and downloads. Add a build/static-serving check for `_headers` and test `/`, `/invite` and SPA fallback paths on hosted preview.
  - Rate limit (mock the binding in tests):
    - `rateLimit` returns 429 when the binding denies the request; missing/erroring bindings fail closed outside explicit test/local mocks
    - login checks both the per-IP and per-username keys
    - the `rate_limits` table no longer exists after migrations
    - verify 5/min versus 10/min binding selection, normalized username keys, upload actor keys and separate preview/production namespaces
  - Lifecycle:
    - password change atomically revokes other sessions and preserves the current one
    - logout-all works
    - account deletion removes every user-scoped row and blob; forced R2 failure retains durable retries after the user is gone
    - a deactivated athlete can't log in or use an existing session, is hidden from the default team list, can be reactivated, and keeps their data
    - owner deletion is refused before transfer and allowed after it
    - last-coach deletion is refused
    - deleting a coach preserves athlete data/files, nulls inviter references and leaves their athlete invites usable; creatorless coach invites fail
    - after a transfer there is exactly one owner and `/api/auth/me` reflects it; invalid targets and concurrent transfer/delete leave ownership intact
    - login/deactivation and in-flight import/upload races obey §7; repeated deactivate/reactivate is idempotent
    - old-owner coach invites cannot be accepted after transfer; 0001's concurrent invite claim protection still holds after adding the user column
    - scheduled cleanup respects expiry/30-day boundaries, is repeatable, retries R2 failures and keeps currently referenced objects
  - Upload quota: the 101st file and the upload that would pass 500 MB are both rejected
  - Coach overview: the response body contains no session notes, focus, scores, weekly notes, setups or inspiration fields. Seed distinctive strings and assert they're absent. Inspect executed query projections/table access to prove private rows were never loaded, and verify aggregate parity with the athlete dashboard.
  - Errors: a simulated R2 failure returns a generic message.
- Manual: on the preview environment from 0001, check signup, login, upload/download, rate limiting, deactivation and PWA install, since hosted-runtime limits differ from local `workerd`.
- Frontend suites: fragment and legacy invite links, upload transport/error messages, Settings lifecycle controls, owner-transfer picker, Team deactivation toggle, and query-cache invalidation after role/session/account changes. Exercise the built SPA under CSP in a browser; jsdom does not enforce it.
- Update `test/worker/helpers.ts` storage reset and limiter tests when dropping `rate_limits`; include any cleanup/staging/reservation tables. Add migration coverage from populated `0002_team_auth.sql` data, plus a repeatable size-backfill check.

## Codebase Integration:
- follow established conventions, best practices, testing, and architecture patterns from the project's aspec.
- Put shared validation schemas in the module layout set up by work item 0001. Don't add more exports to `routes/tracker.ts`.
- Schema changes (deactivation, byte sizes, removal of `rate_limits`, cleanup/reservation or import-mapping tables as needed) go in new drizzle-kit generated migrations (`migrations/0003_*` or later), with matching snapshots/journal. Never edit either applied migration. Keep foreign-key and owner-index invariants, and review explicit-column/raw inserts against the new schema.
- Update `README.md`: API overview (new endpoints), roles table (deactivation, ownership transfer), import limits, upload quotas, admin password reset procedure.
- Update the matching `aspec/` files filled in by 0001: foundation, design, security, experience, operations, infrastructure (Rate Limiting bindings, Cron Triggers), localdev and apis. Turn this item's `Planned (work item 0002):` notes into current behaviour only as the corresponding implementation lands. Preserve the owner-managed exclusions for `.awman/` and `aspec/devops/subagents.md`.
- Completion requires the existing checks (`typecheck`, `lint`, `docs:check`, `db:check`, `test`, `build`), the new acceptance coverage above and recorded hosted-preview verification. Preview resource IDs remain placeholders in the checked-in config: the environment configuration from 0001 alone is not evidence that a live preview has passed these checks.

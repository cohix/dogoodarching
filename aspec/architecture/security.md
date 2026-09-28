# Security

## API Security

Transport:

- HTTPS is provided by Cloudflare. Session cookies use `Secure` when the request URL is HTTPS; local HTTP omits that flag. Cookie lifetime/attributes and public routes are defined in [API authentication](apis.md#design).

Authentication:

- Username/password authentication uses PBKDF2-HMAC-SHA256 via WebCrypto, a random 16-byte salt and a 256-bit derived hash. Current hashes encode `pbkdf2$210000$<base64 salt>$<base64 hash>`; verification requires the current fixed iteration count and compares derived bytes without early exit. Unknown usernames still incur password hashing work.
- **Current hosted blocker:** the 210,000 iterations in `lib/auth.ts` exceed the hosted Workers 100,000 limit identified in [REVIEW C2](../../REVIEW.md#c2-pbkdf2-iteration-count-is-above-the-production-workers-limit). Local workerd accepts this count; hosted bootstrap, accept-invite and login remain broken. **Planned (work item 0002):** lower to 100,000, validate stored iteration counts and rehash supported older hashes on login. Hosted Workers cannot verify existing 210,000-iteration local hashes; those accounts may need recreation/reset after the change.
- Session and invite tokens contain 32 random bytes (256 bits), are rendered as hex, and are stored only as SHA-256 hashes. Invite validity and lifecycle are described in [experience](../uxui/experience.md#signup-and-account).
- Bootstrap inserts the owner only when no user exists. Invite acceptance claims the invite and creates its user in one D1 batch; username conflicts roll back the claim. The claim checks expiry, unused state and continuing owner authority for coach invites inside the batch.

RBAC:

- [Foundation](../foundation.md#personas) is the permission reference. `authMiddleware` hashes the cookie and joins an unexpired session to its user. `requireCoach` rejects athletes; `resolveAthlete` checks target ID and athlete role, without an inviter condition. The owner flag gates coach invites and coach listing, and controls invite listing/revocation scope.
- Personal routes pass the authenticated user ID to services. Coach plan routes pass only the resolved athlete ID. Downloads use the explicit exception documented in foundation.
- The privacy rule is that coach responses never contain private logs and coach code paths should never select private log columns. **Current gap:** `getCoachOverview` calls `getTrackerPayload` then picks five public fields. Private rows are queried internally even though they are not returned. **Planned (work item 0002):** a dedicated overview query will enforce the rule before data is loaded.

## Input validation

`lib/validation.ts` centralizes enums and Zod schemas, with HTTP wrappers in `lib/http.ts`. Normal write paths validate calendar dates, bounds and string lengths; link and inspiration URLs use `httpUrl` (http/https only). SQL uses Drizzle or parameterized tagged SQL.

Import currently shares schema location and some enums but not normal field bounds: it accepts unbounded arrays, general date/URL strings, arbitrary attachment kinds and unchecked sight-mark JSON strings. The frontend's `SafeLink` is an additional URL check, not a substitute for server validation. Import also silently omits ends with no mapped parent. **Planned (work item 0002):** share normal field schemas, restrict imported attachments to links, validate relationships/natural-key uniqueness and apply size caps.

## File attachments

The download service permits the attachment's user or any coach; other callers get 404. R2 keys are not public URLs. Responses include `Content-Disposition: attachment; filename="<ascii-fallback>"; filename*=UTF-8''<encoded-name>`, a MIME-derived extension, `X-Content-Type-Options: nosniff`, byte length and `Cache-Control: private, max-age=3600`. This permits private browser HTTP caching; it is separate from the service worker's network-only API rule.

The frontend resolves attachment links against the page origin and allows same-origin paths only under `/api/plan/attachments/`; other destinations must be http/https. Same-origin file links use a plain anchor to preserve the PWA session context, while external links open with `noopener noreferrer`.

Uploads currently accept base64 JSON, decode fully in memory and reject decoded bytes above 8,000,000 with 400. MIME metadata is caller supplied; there is no MIME allowlist or per-user storage quota. Upload catch handlers can return raw D1/R2 error messages as 400. Storage ordering and failure limitations are in [attachment/transfer design](design.md#component-6).

## Rate limiting

Current `lib/rate-limit.ts` uses D1 `rate_limits` fixed windows:

| Operation | Key | Limit |
|---|---|---|
| Bootstrap | IP | 10/hour |
| Login | IP | 20/10 minutes |
| Accept invite | IP | 20/10 minutes |
| Create invite | Acting coach ID | 20/hour |

Middleware runs before body validation, so invalid attempts count. IP resolution uses `CF-Connecting-IP`, then the first `X-Forwarded-For` value, then `unknown`. A conditional atomic upsert counts each allowed attempt and resets only that key when its window expires. Blocked attempts do not increment the count. Inactive keys remain stored until the table is removed in 0002. There is no username or upload limiter yet.

## Secrets

No Worker secrets or application environment variables are required today; see [operations](../devops/operations.md#installing-and-running) for CI credentials. Public bootstrap remains an accepted risk: anyone reaching a zero-user deployment can become owner (REVIEW H1). This is explicitly deferred and is not fixed by 0002.

## Planned (work item 0002):

- Fix password hashing as described above.
- Add Origin/`Sec-Fetch-Site` CSRF checks, explicit JSON content-type rejection, and `SameSite=Strict` unless a flow requires Lax.
- Add security headers to static assets and API responses (CSP, HSTS, Referrer-Policy, nosniff and Permissions-Policy); move invite tokens to URL fragments while supporting older path links.
- Stream uploads, add a MIME allowlist, retain the per-file size limit and add quotas of 100 files/500 MB per athlete. Coach uploads count against the target athlete. Persist byte sizes and rate-limit the acting uploader.
- Harden import validation, ID mapping, overall import size limits and post-commit R2 cleanup, as described in [design](design.md#component-6).
- Replace D1 rate limiting with the Workers Rate Limiting binding and remove `rate_limits`. The binding is approximate and per Cloudflare location, with 10- or 60-second periods; the planned starting limits are per-minute rather than the current windows. Remove the forwarded-IP fallback.
- Add password change/session revocation, athlete deactivation/reactivation, ownership transfer and account deletion under the [lifecycle rules](../uxui/experience.md#signup-and-account), plus [scheduled cleanup](../devops/operations.md#scheduled-cleanup-jobs).
- Query only permitted data in coach overviews and return generic upload failures except for typed user-facing errors.

These are future changes from [work item 0002](../work-items/0002-security-hardening.md), not current protections.

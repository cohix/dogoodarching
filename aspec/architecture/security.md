# Security

## API Security

Transport and CSRF:

- HTTPS is provided by Cloudflare; cookie attributes and public routes are in [API authentication](apis.md#design).
- `sameOriginGuard` runs before routing, authentication, rate limiting or parsing on every unsafe `/api/*` request, including JSON, raw uploads and bodyless mutations. GET/HEAD/OPTIONS are exempt. A present `Origin` must exactly match the request URL origin (scheme, host and port); empty, `null`, sibling-site and conflicting origins receive 403. Only an absent Origin can fall back to `Sec-Fetch-Site: same-origin`. Neither proof means 403 `{ error: "Same-origin request required" }`. Forwarded host/protocol headers are not trusted.
- There is no CSRF-token fallback or missing-header exception. Installed-PWA verification remains required; see [setup](../uxui/setup.md#user-installation).

Authentication:

- `lib/auth.ts` uses PBKDF2-HMAC-SHA256. Stored format is `pbkdf2$<iterations>$<base64 salt>$<base64 hash>`, with a 16-byte salt and 32-byte derived hash. New hashes use 100,000 iterations; verification accepts integer counts 10,000–100,000 inclusive, read from the stored value. Counts with signs, fractions or leading zeros, invalid base64, empty fields and wrong decoded lengths fail safely. Comparison covers all 32 bytes without early exit.
- Successful login upgrades a supported lower count to 100,000 with an update conditional on the verified hash, so it cannot overwrite a concurrent password change. Unknown/deactivated users and unsupported hashes burn a fresh derivation; wrong passwords derive at the stored supported count. This provides password-work costs without promising identical timing across different counts.
- Existing 210,000-iteration hashes fail authentication in every environment. Use the [operator reset](../devops/operations.md#admin-runbook), preserving data and ownership and revoking sessions. Temporary hosted bootstrap/invite acceptance/login passed; remaining deployment/device checks are recorded in [README](../../README.md#verification-status).
- Session and invite tokens contain 32 random bytes, rendered as hex and stored only as SHA-256 hashes. Invite expiry/single-use rules are in [experience](../uxui/experience.md#signup-and-account).
- New invite links use `/invite#<token>`. The SPA captures fragments and legacy `/invite/<token>` paths, immediately replaces the URL with `/invite`, and retains the token only in component state. Reload before acceptance requires reopening the original link. Fragments stay out of request lines and Referer; scrubbing cannot erase the initial request of an old path link.
- Bootstrap conditionally inserts the owner only into an empty deployment. Invite claim and account creation share one D1 batch with continuing owner-authority checks for coach invites and rollback on username conflicts.

RBAC:

- [Foundation](../foundation.md#personas) owns permissions and account lifecycle rules. Authentication joins an unexpired session to an active user. Session creation also checks active state, preventing login/deactivation races from leaving a session that reactivation would revive. `resolveAthlete` accepts active or deactivated athletes, never coaches.
- Personal services receive the authenticated user ID; coach services receive the resolved athlete ID. Downloads have the explicit foundation exception.
- `getCoachOverview` never calls `getTrackerPayload`. Its six queries read program state, cycle week plans, planned overrides, attachments, SQL weekly arrow sums and distinct session dates. Training queries project only aggregates/date, with user/date bounds; they never select session notes, focus or score. Private scores, weekly notes, setups, maintenance, milestones and inspiration tables are not queried. The five-field response remains unchanged. Query-projection tests enforce this boundary as well as checking response privacy.

Failed supported lower-count password checks perform dummy PBKDF2 work to reach 100,000 total iterations, comparable to unknown/deactivated users. A losing conditional rehash fails authentication, and login session insertion checks the exact verified/upgraded hash so password change or operator reset cannot be followed by a stale-password session.

## Input validation

`lib/validation.ts` centralizes Zod schemas; `lib/http.ts` wraps them. JSON endpoints require `application/json` with an optional charset before parsing (415 otherwise); malformed JSON and schema errors return 400. Bodyless operations and raw uploads use their own contracts. Normal writes bound strings/numbers and restrict link/video URLs through `httpUrl` to HTTP(S). Shared `dateInput` validates real calendar dates for imports, session/score writes, week notes and `today`; cursors also validate calendar dates. SQL is parameterized.

Import field, relationship and resource checks are described below. The frontend `SafeLink` check is defense in depth, not a server validation substitute. [API conventions](apis.md#design) document current import limits and responses.

## File attachments

The download service permits the attachment's owner or any coach; other callers receive 404. R2 keys are private. Responses use `Content-Disposition: attachment` with an ASCII fallback and UTF-8 filename, a MIME-derived extension, byte length, `nosniff`, and `Cache-Control: private, max-age=3600`. This browser HTTP cache is separate from the service worker's network-only API rule.

`UPLOAD_MIME_TYPES` in `src/lib/validation.ts` is the authoritative allowlist:

- `image/jpeg`, `image/png`, `image/webp`, `image/heic`
- `application/pdf`
- `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `application/vnd.ms-powerpoint`, `application/vnd.openxmlformats-officedocument.presentationml.presentation`

MIME metadata is trimmed, lowercased and stripped of parameters. Unsupported/missing types are rejected on upload; legacy downloads use `application/octet-stream` and a `.bin` extension for unsupported metadata. No file-magic inspection is performed.

Files are limited to 8,000,000 bytes each and 100 files / 500,000,000 bytes per target account, excluding links. Personal uploads by either role use their own quota; coach uploads use the athlete's quota. Atomic admission counts committed files plus live reservations and rejects unknown sizes rather than counting them as zero. Above-quota accounts retain reads/deletes/links. See [upload transport](apis.md#design), [reservation design](design.md#component-7) and the [backfill rollout](../devops/operations.md#ongoing-operations).

Same-origin file links use plain anchors under `/api/plan/attachments/` to preserve PWA session context. External HTTP(S) links open with `noopener noreferrer`.

## Rate limiting

`lib/rate-limit.ts` selects Workers Rate Limiting bindings through the shared `rateLimit` middleware interface (including validated username keys). D1 `rate_limits` was dropped in migration 0003. Limits are approximate and counted per Cloudflare location, not strict global counters. Both bindings use 60-second periods (the binding supports 10 or 60 seconds).

| Operation | Prefixed key | Limit per minute |
|---|---|---|
| Bootstrap | `bootstrap:<ip>` | 5 |
| Login IP | `login:<ip>` | 10 |
| Login username | `login-user:<lower(trim(username))>` | 5 |
| Accept invite | `accept-invite:<ip>` | 10 |
| Create invite | `invite-create:<acting coach ID>` | 10 |
| Upload (personal or coach) | `upload:<acting user ID>` | 10 |
| Password change, account deletion, ownership transfer | shared `password-verify:<acting user ID>` | 5 |

IP checks precede body parsing; username checks follow validation but precede hashing without looking up username existence. Password-verification limits follow body validation and precede hashing. Upload limits precede body reading. IP uses only `CF-Connecting-IP`, falling back to `unknown`, never `X-Forwarded-For`.

Denial returns 429 `Too many attempts. Try again later.` Missing/erroring bindings and unknown mock modes fail closed with 503 `Service temporarily unavailable. Try again later.` Production/preview namespaces are distinct in [infrastructure](../devops/infrastructure.md#architecture). Explicit test mocks are documented in [local development](../devops/localdev.md#workflows); they are not configured in deployed environments.

## Secrets

No Worker secrets are required; [operations](../devops/operations.md#installing-and-running) describes CI credentials. Public bootstrap remains the accepted REVIEW H1 risk: whoever first reaches a zero-user deployment can become owner. It is outside work item 0002.

Security headers are applied to API responses, including errors and direct downloads, by outer `hono/secure-headers` middleware. Static delivery is described in [infrastructure](../devops/infrastructure.md#architecture). Both specify:

```text
Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
```

There is deliberately no `style-src` exception: it falls back to `default-src 'self'`. No `unsafe-inline`, `unsafe-eval` or extra script hosts are allowed. The request-hardening handoff records local Chromium/WebKit checks of external Vite assets, React CSSOM styles, Recharts/tooltips and allowed iframe origins without CSP violations. Controlled frame responses did not verify live provider playback; hosted real-browser verification remains required. API middleware also sets `X-Frame-Options: DENY` and Hono's additional defaults.

Only deliberate `UserFacingError` messages/statuses are exposed for expected service failures. Unexpected uploads return 500 `Upload failed`; other unhandled exceptions return 500 `Internal server error`. These boundaries log fixed events, without arbitrary exception text, request bodies, passwords or tokens. Rate-limit binding failures currently log the thrown binding error server-side; cleanup stores at most 500 characters of R2 error text in private `blob_cleanup.last_error`. Neither is returned to clients.

## Import hardening

Import accepts at most 8,000,000 UTF-8 request bytes, 20,000 sessions, 5,000 scores, 50,000 ends, six week plans, seven day overrides, 1,000 setups and 5,000 rows in each other array. Every field uses the normal write validators; dates must exist, links must be HTTP(S), sight marks must be an object of strings, and scores must contain ten unique ends with consistent totals. Duplicate IDs/keys and orphan relationships return indexed 400 errors. Program cycles and elapsed-time advancement are capped at 200 cycles.

The complete replacement must fit 40 D1 statements, including guards, cleanup enqueue and mapping removal. JSON row chunks contain at most 1,000 rows and 128,000 UTF-8 bytes; each statement is preflighted for 100 bound parameters, 100,000 SQL bytes and 128,000 bytes per bound string. This deliberately fits the Free plan’s 50-query invocation budget, including authentication and one prompt blob-cleanup attempt, and also works on Paid. Effective capacity depends on row widths and populated collections: the row caps are ceilings, not a promise that every combination fits. Oversize requests/batches return 413 before any destructive write. The operation is never split across committed batches.

AUTOINCREMENT assigns IDs. Temporary per-import UUID/source-ID keys on score and maintenance parents resolve child references inside one D1 batch, then are cleared before commit. Every statement checks that the actor is still active. The same batch records the keys of the actual attachments it replaces in durable cleanup, including concurrent coach uploads. R2 deletion happens only after commit; failure is logged and retried by cron while import still succeeds. Rollback leaves existing rows and referenced files intact.

Limits are chosen conservatively against [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/). Normal imports use parameterized `json_each` chunk inserts rather than one parameter per field per row. Mapping keys are never exposed by export.

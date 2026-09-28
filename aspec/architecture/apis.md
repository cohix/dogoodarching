# APIs

Convention: rest  
Protocol: http

## Design:

Versioning:

- Unversioned `/api/*`. The SPA and API are built/deployed together from one Worker, so releases share a contract; already-open clients can still span a deployment.
- A separately released client, such as a native mobile app, or an incompatible externally consumed contract would be a reason to introduce `/api/v2`. No such client exists today.

Objects:

- Requests and responses are JSON; file downloads are binary, and export is a JSON attachment. Current uploads are JSON with base64 bytes. Application errors always use `{ error: string }`; Cloudflare-generated transport errors are outside that handler.
- Calendar dates are `YYYY-MM-DD`; response instants are ISO strings except invite-list `expiresAt`, `usedAt` and `createdAt`, which retain epoch-ms numbers (`usedAt` can be null). See the [storage timestamp convention](design.md#timestamp-convention).
- User, auth-session and invite IDs are UUID strings. Tracker row IDs are integers; state, plans and checks also use per-user natural keys.
- Public users are `{ id, username, role, isOwner }`, without password hashes, `coachId` or inviter provenance.

| Status | Application meaning |
|---|---|
| 400 | Invalid JSON/schema, query or ID; unknown/revoked invite; current upload errors, including the decoded size limit |
| 401 | Missing/invalid/expired session or invalid login credentials |
| 403 | Coach or owner permission denied |
| 404 | Missing/inaccessible record, non-athlete target, unavailable file or unknown authenticated API route |
| 409 | Bootstrap already completed or invite-accept username conflict |
| 410 | Invite expired, used, or no longer claimable because its coach creator is no longer owner |
| 413 | **Planned (work item 0002):** explicit upload quota/size and oversized import handling; no current application handler returns this |
| 415 | **Planned (work item 0002):** explicit non-JSON content-type rejection; no current application handler returns this |
| 429 | Authentication/invitation rate limit exceeded |
| 500 | Unexpected failure, normally `Internal server error`; see [current upload error exception](security.md#file-attachments) |

Authentication:

- The `dga_session` cookie is HttpOnly, `SameSite=Lax`, `Path=/`, Secure over HTTPS, with a 30-day TTL matching the stored session. Only its SHA-256 hash is stored. [Security](security.md#api-security) describes password/token primitives and the hosted hashing blocker.
- Public endpoints are auth status, bootstrap, login and accept-invite. Other endpoints require the cookie; coaches also have access checks defined in [foundation](../foundation.md#personas).

Conventions:

- Every body-bearing write endpoint runs shared Zod schemas through `@hono/zod-validator` via `validateJson`; bodyless logout/delete operations need no body validator. Send `Content-Type: application/json`. Malformed JSON and schema failures return 400 with the first issue message. There is currently no explicit 415 guard, and import's field rules remain weaker; see [security](security.md#input-validation).
- Coach athlete operations are nested under `/api/coach/athletes/:athleteId/...`, usable by any coach for any athlete after `resolveAthlete` succeeds. Lists are under `/api/coach/athletes` and owner-only `/api/coach/coaches`.
- Updates/deletes of sessions, scores, maintenance items and existing setups inspect affected rows and return 404 for no match. Attachment/invite deletes and setup duplication also report missing records. Plan/check/note upserts intentionally create missing state; this is not a universal 404 rule for all writes.
- History uses `GET /api/tracker?today=YYYY-MM-DD&before=YYYY-MM-DD,id`. Pass the last session's date and ID as the exclusive cursor, ordered descending by both fields. At most 100 sessions return per page. Only sessions paginate; the rest of the tracker payload is rebuilt normally. There is no separate next-cursor field.
- Initial poundage saves send `{ poundage, today }`, with the client’s local calendar date. Omitted `today` retains the server-UTC fallback for older clients; saved program anchors are preserved.
- Personal and coach plan saves return `{ dayKey, sessionType, detail, prescription, updatedAt }`; display labels and attachments come from tracker/overview reads.
- Success is generally 200; bootstrap, invite acceptance and invite creation return 201. Consult the [README endpoint list](../../README.md#api-overview) for routes rather than maintaining a second inventory here.

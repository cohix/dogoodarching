# APIs

Convention: rest  
Protocol: http

## Design:

Versioning:

- Unversioned `/api/*`. SPA and API deploy together; already-open clients can span a release. No separately released native client exists.
- Export/import uses version 1 independently of the HTTP contract.

Objects:

- Requests/responses are JSON except raw file uploads and binary downloads; export is a JSON attachment. Application errors use `{ error: string }`; platform transport errors are outside this handler.
- Calendar dates are `YYYY-MM-DD`; response instants are ISO strings except invite-list `expiresAt`, `usedAt`, `createdAt`, which remain epoch-ms numbers (`usedAt` nullable). See [storage timestamps](design.md#timestamp-convention).
- User, session and invite IDs are UUIDs; tracker row IDs are integers. Plans/state/checks also use per-user natural keys. Public users remain `{ id, username, role, isOwner }`.

| Status | Application meaning |
|---|---|
| 400 | Invalid JSON/schema/query/ID; unknown invite; incorrect current password; invalid upload metadata, empty or mismatched body, expired upload reservation |
| 401 | Missing/expired/invalid session, deactivated user, invalid login or upload account no longer available |
| 403 | Role/owner permission denied or missing/conflicting same-origin proof |
| 404 | Missing/inaccessible record, invalid coach/athlete target, unavailable file or unknown authenticated route |
| 409 | Bootstrap complete, username conflict, stale password/account/ownership operation, owner or last-coach deletion refused |
| 410 | Invite expired, used or no longer claimable under its creator's authority |
| 413 | Upload file/byte quota, per-file size or incomplete size accounting; import request/atomic batch/resource limits |
| 415 | Missing/non-JSON Content-Type on a JSON endpoint, or unsupported/missing upload MIME |
| 429 | Rate limit exceeded |
| 500 | Unexpected `Internal server error`, or `Upload failed` at the upload service boundary |
| 503 | Rate Limiting binding unavailable (fail closed) |

Authentication and common gates:

- `dga_session` is HttpOnly, `SameSite=Strict`, `Path=/`, Secure over HTTPS, with a 30-day TTL matching the stored session. Only its SHA-256 hash is stored.
- Status/bootstrap/login/accept-invite are public; other endpoints require a session. [Foundation](../foundation.md#personas) owns role/lifecycle policy.
- All unsafe requests need [same-origin proof](security.md#api-security), even public, raw or bodyless requests (403). JSON endpoints require `Content-Type: application/json`, optionally a charset (415 before parsing). Malformed JSON and schema failures are 400. Bodyless endpoints need no Content-Type.
- Every authenticated endpoint can return 401; coach/owner gates add 403. Unexpected failures can return 500. The tables below list additional operation-specific responses; JSON rows also inherit 400/415 and all unsafe rows inherit CSRF 403.

Account and invitation contracts:

| Method and path | Input / success | Additional failures |
|---|---|---|
| `GET /api/auth/status` | 200 `{ setupRequired }` | — |
| `POST /api/auth/bootstrap` | JSON `{ username, password }`; 201 public user and session | 401 if session cannot start; 409 setup completed; 429/503 |
| `POST /api/auth/login` | JSON credentials; 200 public user and session | 401 generic `Invalid username or password`, including deactivated users; 429/503 |
| `POST /api/auth/accept-invite` | JSON `{ token, username, password }`; 201 public user and session | 400 invalid invite; 401 session cannot start; 409 username; 410 invalid/expired/used authority; 429/503 |
| `GET /api/auth/me` | 200 public user | — |
| `POST /api/auth/logout` | No body; 200 `{ ok: true }`, clears current session/cookie | — |
| `POST /api/auth/logout-all` | No body; 200 `{ ok: true }`, deletes all caller sessions and clears cookie | — |
| `POST /api/auth/password` | JSON `{ currentPassword, newPassword }`; 200 `{ ok: true }`, retains caller session and atomically revokes others | 400 `Incorrect password`; 409 stale verified hash; 429/503 |
| `DELETE /api/auth/account` | JSON `{ password }`; 200 `{ ok: true }`, clears cookie after guarded deletion | 400 `Incorrect password`; 409 owner, last active coach, or concurrent account change; 429/503 |
| `POST /api/auth/owner/transfer` | Owner; JSON `{ coachId, password }`; 200 `{ ok: true, previousOwnerId, newOwnerId }` | 400 self target / incorrect password; 403 not owner; 404 target not active coach; 409 stale transfer; 429/503 |
| `POST /api/auth/invites` | Coach; JSON `{ role }` (defaults athlete); 201 `{ token, invitePath, expiresInHours }`; fragment path | 403 coach invitation without ownership; 429/503 |
| `GET /api/auth/invites` | Coach; 200 invite list within caller's scope | — |
| `DELETE /api/auth/invites/:id` | Coach; no body; 200 `{ ok: true }` | 404 missing/inaccessible invite |

New passwords are 8–128 characters; current-password confirmations are 1–128. Transfer `coachId` is 1–64 characters. Password changes reject a stale verified hash with 409 `Password was changed by another request. Sign in again and retry.` Owner deletion returns 409 `Transfer ownership before deleting your account`; last-coach deletion returns 409 `The last coach cannot delete their account`. Other guarded deletion/transfer conflicts instruct sign-in or refresh/retry. Account deletion queues owned blobs atomically and attempts deletion after commit; scheduled retries survive the user.

Team contracts (coach required):

| Method and path | Success | Additional failures |
|---|---|---|
| `GET /api/coach/athletes` | 200 `{ athletes: [...] }`, active only; `?include=deactivated` includes all | 400 any other `include` value |
| `GET /api/coach/coaches` | Owner only; 200 `{ coaches: [...] }`, source for transfer picker | 403 non-owner |
| `POST /api/coach/athletes/:athleteId/deactivate` | No body; 200 athlete summary; idempotent, revokes sessions | 404 unknown ID or coach target |
| `POST /api/coach/athletes/:athleteId/reactivate` | No body; 200 athlete summary; idempotent | 404 unknown ID or coach target |
| `GET /api/coach/athletes/:athleteId/overview` | 200 `{ state, weeklyPlans, plannedSessions, weeklyArrows, cycleSummaries }`; optional `today` | 400 invalid query; 404 non-athlete/missing target |

Athlete summaries always include `{ id, username, createdAt, deactivatedAt }`; the last field is an ISO instant or null. Deactivated athletes retain coach plan/overview access. Deactivation repeated twice preserves its original timestamp. Coach plan edits retain `PUT /plan/sessions`, `PUT /plan/weeks`, `POST /plan/adjust`, `POST /plan/sessions/links` and `DELETE /plan/attachments/:attachmentId` under `/api/coach/athletes/:athleteId`; success is 200, invalid input is 400, missing targets/attachments are 404.

Upload transport:

| Method and path | Success | Additional failures |
|---|---|---|
| `POST /api/plan/sessions/files` | Either role, own quota; 200 `{ id }` | 400/401/413/415/429/500/503 |
| `POST /api/coach/athletes/:athleteId/plan/sessions/files` | Coach, athlete quota; 200 `{ id }` | 400/401/403/404/413/415/429/500/503 |

Both send the original file as the raw body, with query parameters `dayKey` (mon–sun), `kind` (`document` or `photo`) and `label` (trimmed 1–160 characters). `Content-Type` is the actual file MIME; see the [exact allowlist and quotas](security.md#file-attachments). There is no JSON/base64 or multipart envelope. The browser client uses `body: file`, includes credentials and sends `X-File-Size: file.size`; it never sets Content-Length or Origin itself.

A declared oversize length is rejected before reading. Content-Length or X-File-Size is required; if both are present they must agree. A counted FixedLengthStream pipes directly to R2 with backpressure and checks actual bytes and exact length at EOF. Invalid length syntax, empty body, truncated/mismatched length and expired/revoked commit eligibility return 400. Size/quota/accounting failures are 413 with messages identifying 8 MB, 100 files, 500 MB, or incomplete accounting. MIME failure is 415 `Unsupported file type`; unexpected service failure is 500 `Upload failed`. Middleware runs before upload validation, so its first failing gate determines the response.

`GET /api/plan/attachments/:id/file` is the shared download route for both roles: 200 bytes, 400 malformed ID, 404 inaccessible/missing file. Personal `DELETE /api/plan/attachments/:id` and coach deletion above return 200 `{ ok: true }`, 400 invalid ID or 404 missing attachment; durable cleanup runs after D1 removal.

Import/export:

- `GET /api/export`: 200 JSON download containing only the caller's data and link attachments. File bytes are excluded.
- `POST /api/import`: JSON version-1 payload, 200 `{ ok: true, counts }`; invalid fields/relationships are indexed 400 errors, oversize requests/batches are 413, inactive actors are 401, wrong media type is 415 and unexpected database failure is 500; post-commit storage failure retains successful import with durable cleanup. `programState: null`, null poundage and ignored legacy `entries` remain compatible; all required empty arrays plus null state clear personal data. `{}` is invalid.
- Import accepts at most 8,000,000 UTF-8 request bytes, 20,000 sessions, 5,000 scores, 50,000 ends, six week plans, seven day overrides, 1,000 setups and 5,000 rows in each other array. Every field uses the normal write validators; dates must exist, links must be HTTP(S), sight marks must be an object of strings, and scores must contain ten unique ends with consistent totals. Duplicate IDs/keys and orphan relationships return indexed 400 errors. Program cycles and elapsed-time advancement are capped at 200 cycles.
- The complete replacement must fit 40 D1 statements, including guards, cleanup enqueue and mapping removal. JSON row chunks contain at most 1,000 rows and 128,000 UTF-8 bytes; each statement is preflighted for 100 bound parameters, 100,000 SQL bytes and 128,000 bytes per bound string. This deliberately fits the Free plan’s 50-query invocation budget, including authentication and one prompt blob-cleanup attempt, and also works on Paid. Effective capacity depends on row widths and populated collections: the row caps are ceilings, not a promise that every combination fits. Oversize requests/batches return 413 before any destructive write. The operation is never split across committed batches. See [transfer design](design.md#component-6) for atomic parent mapping and post-commit cleanup. No staging/mapping endpoint exists.

Other conventions:

- Updates/deletes of sessions, scores, maintenance items and existing setups return 404 for no match; plan/check/note upserts create missing state.
- `GET /api/tracker?today=YYYY-MM-DD&before=YYYY-MM-DD,id` returns at most 100 sessions, descending by date then ID, with the exclusive cursor taken from the last row. Other collections do not paginate. No separate next-cursor field exists.
- Initial poundage sends `{ poundage, today }`; omitted `today` uses server UTC and existing anchors are preserved.
- Personal and coach plan saves return `{ dayKey, sessionType, detail, prescription, updatedAt }`; display labels and attachments come from reads.
- Success is generally 200, with auth creation exceptions above. The [README API overview](../../README.md#api-overview) inventories the remaining tracker/gear routes.

# Operations

## Installing and running

Installation:

- Follow the [README quick start](../../README.md#quick-start) for dependencies, Wrangler authentication, D1/R2 provisioning and placeholder database IDs. [Infrastructure](infrastructure.md#architecture) owns binding names.

Setup and run:

- Apply migrations, build and deploy the matching backend/frontend. Fresh databases have no seeded account; follow [first run](../../README.md#first-run-accounts-roles-invites). For upgrades with uploads, use the gated rollout below.
- Local success is not hosted verification. The [required preview checks](../../README.md#verification-status) are partially verified; hosted R2/Cron and physical installed-PWA checks remain.

Environment variables:

- No application string variables are required in deployment. D1, R2 and Rate Limiting are resource bindings. `RATE_LIMIT_MODE` is an explicit local/test mock only; never configure it in preview/production. CI/tooling sets `WRANGLER_SEND_METRICS=false`.

Secrets:

- No Worker secrets are required. Public bootstrap remains an accepted risk under [security](../architecture/security.md#secrets).
- GitHub Actions needs no Cloudflare credentials: CI only checks and builds. Cloudflare (Workers Builds) deploys with credentials managed in the Cloudflare dashboard; if its build/deploy command also applies migrations, its token needs D1: Edit. Local operators use `wrangler login`.

## Environments

Preview and production have independent storage and limiter namespaces. Top-level Wrangler configuration is production; `[previews]` configures Preview deployments of the same Worker, created with `wrangler preview`. D1 commands reach the preview database with `--preview` (`execute`, `migrations apply`) or by its name `dogoodarching-preview` (`export`). See [CI/CD](cicd.md#pipelines) for automation.

| Target | Apply migrations | Build and deploy |
|---|---|---|
| Local | `npm run db:migrate:local` | `npm run build && npm run dev` |
| Preview | `npm run db:migrate:preview` | `npm run deploy:preview` |
| Production | `npm run db:migrate` | `npm run deploy` |

Cloudflare performs routine deploys; the deploy scripts are for manual deploys. Neither migrates: apply the matching migrations first (or make Cloudflare's deploy command do so). Nothing automates the upload gate/drain or backups below.

## Ongoing operations

Version upgrades/downgrades:

- Change dependencies and lockfile together; review compatibility-date changes. Run typecheck, lint, docs/schema checks, tests and build, then exercise hosted preview before production.
- Worker rollback does not reverse D1/R2 changes. Confirm schema compatibility and prefer corrective forward migrations. Do not restore the old base64 uploader with upload traffic enabled: it creates uncounted files.

Database migrations:

1. Edit `src/db/schema.ts`, generate with `npm run db:generate`, and commit reviewed SQL plus snapshots/journal. Never edit applied migrations.
2. Review rebuilds, FK cascades, data copying and D1 limits. `0002_team_auth.sql` preserves valid rows/score ends, removes user-owned orphans and `entries`, nulls broken inviter references and chooses the earliest coach as owner. Existing program anchors stay; missing states are backfilled to 24 lb / cycle 2 / week 6 at migration time. New accounts use neutral defaults. Later migrations are `0003_drop_rate_limits.sql`, `0004_lifecycle.sql`, `0005_upload_accounting.sql` and `0006_import_mapping.sql`; see [schema summary](../architecture/design.md#data-model-summary).
3. Run `npm run db:check` (generation/no drift, not migration execution), apply locally, and test empty and populated legacy schemas.
4. Back up before remote changes, e.g. `npx wrangler d1 export dogoodarching-preview --remote --output preview-before-migration.sql` (use `dogoodarching` for production). Protect exports outside version control.
5. Apply/verify preview first, then production, before the code that needs the new schema is deployed. CI does not apply migrations, make backups or coordinate old upload writers.
6. Inspect `PRAGMA foreign_key_check`, account access, program state and attachment metadata after migration.

**Attachment size backfill and rollout ordering:**

1. Temporarily gate file-upload routes at the deployment edge and drain old in-flight uploads. Apply migration 0005 before deploying the new code; existing attachment sizes become NULL.
2. Deploy matching backend and raw-file frontend together. Ensure no old Worker version can accept uploads before running backfill. Other operations need not be gated.
3. Allow the scheduled job to run `backfillAttachmentSizes` from `services/attachments.ts`, or invoke it in a trusted Worker context. There is no public/admin backfill endpoint. Each scheduled run heads at most 50 unknown non-link objects; explicit function limits clamp to 1–100. NULL/oldest `size_checked_at`, then ID, determine retry order. Conditional ID/key/NULL updates make retries resumable and idempotent.
4. Inspect progress with the query below. `head().size` is authoritative, including a confirmed zero-byte legacy object. Missing/invalid/failed heads stay NULL, never zero; retries rotate so they do not starve untouched rows. Restore missing blobs or delete unavailable attachments through the normal endpoint. Backfill never silently removes user rows.
5. Remove the temporary gate once old writers are drained. Enforcement is always on: any target with unknown/negative accounting cannot upload. Targets become eligible as backfill completes; those already above quota must delete files. Reads/deletes/links remain available. [Security](../architecture/security.md#file-attachments) owns the quota values.

```sql
SELECT user_id, count(*) AS unknown_files
FROM planned_session_attachments
WHERE kind != 'link' AND size_bytes IS NULL
GROUP BY user_id;
```

## Backups & restore

D1 SQL export is the explicit pre-change backup. D1 Time Travel provides remote point-in-time recovery; inspect the selected environment's timestamp/bookmark and available recovery window before using Wrangler `d1 time-travel info`/`restore`. The repository defines no retention policy. A restore affects the whole database and must match the deployed schema/code.

R2 bytes require a separate backup: neither D1 recovery nor JSON export includes them. No R2 backup/restore automation exists. Restored bytes must match D1 `blob_key` references. Keep file copies before intentional replacement/deletion. Imports now preserve referenced files on D1 rollback and use durable post-commit cleanup; successful replacement still intentionally removes old file attachments.

## Logs

Use `npx wrangler tail` for production; `wrangler tail` has no preview option, so use the Cloudflare dashboard for Preview deployment logs. No `[observability]`, application alerting or log-retention policy is configured. Global/upload error boundaries log fixed events; the [error-leakage policy and server-side exceptions](../architecture/security.md#secrets) describe what is retained. Scheduled runs log count summaries or `scheduled cleanup failed`. New [fragment invitations](../architecture/security.md#api-security) keep tokens out of request paths; old path links can still appear in initial access logs.

## Admin runbook

Settings supports password change with the current password and sign out everywhere. Forgotten passwords and unsupported 210k hashes require this operator reset; application ownership alone does not grant D1 access. The reset changes only the credential and sessions, preserving role, owner flag and training data (and leaving deactivation unchanged).

1. Back up the chosen database and identify the exact UUID:

   ```bash
   npx wrangler d1 execute DB --remote --command "SELECT id, username, role, is_owner, substr(password_hash, 1, 14) AS hash_prefix FROM users"
   ```

   Add `--preview` for the preview database or use `--local` instead of `--remote`. `pbkdf2$210000$` needs reset; `pbkdf2$100000$` is the current format. All supported counts/encoding lengths are in [security](../architecture/security.md#api-security); there is no local-only 210k exception.

2. Generate using the checked-out `hashPassword` (new password 8–128 characters). From the repository root with Node 22:

   ```bash
   read -r -s -p 'New password: ' DGA_RESET_PASSWORD
   export DGA_RESET_PASSWORD
   node --experimental-strip-types --input-type=module <<'JS'
   import { hashPassword } from './src/lib/auth.ts';
   const password = process.env.DGA_RESET_PASSWORD;
   if (!password || password.length < 8 || password.length > 128) throw new Error('Password must be 8–128 characters');
   console.log(await hashPassword(password));
   JS
   unset DGA_RESET_PASSWORD
   ```

   Confirm output starts `pbkdf2$100000$`: PBKDF2-HMAC-SHA256, 16-byte salt and 32-byte hash in standard padded base64. Do not paste plaintext passwords into SQL or shell command arguments.

3. Put the generated hash and verified UUID into one local SQL file, retaining SQL single quotes. Execute both statements together:

   ```sql
   UPDATE users SET password_hash = 'GENERATED_HASH' WHERE id = 'USER_UUID';
   DELETE FROM sessions WHERE user_id = 'USER_UUID';
   ```

4. Run `npx wrangler d1 execute DB --remote --file /path/to/reset.sql` with the selected environment flags. Repeat the identity/prefix query: verify the intended user's new prefix and unchanged `role`/`is_owner`. Confirm `SELECT count(*) FROM sessions WHERE user_id = 'USER_UUID';` is zero and training rows remain. Test login with the new password; ask the user to change it in Settings (`POST /api/auth/password`). Remove the temporary hash/SQL file. The local password-hash suite exercises this reset and owner preservation; it does not prove hosted login.

## Scheduled cleanup jobs

The [production Cron Trigger](infrastructure.md#architecture) (preview has none) invokes `src/index.ts`'s `scheduled` export, which uses `waitUntil(runScheduledCleanup(...))` with the trigger's scheduled time. Each run is bounded:

1. Delete sessions with `expires_at <= now`, at most 500 rows per statement for 20 rounds.
2. Delete invites used at least 30 days ago, or still unused and expired at least 30 days ago, with the same bounds (inclusive cutoff).
3. Process at most 100 due `blob_cleanup` records, oldest deadline/key first. Never delete a currently referenced attachment or a live upload lease. Expired reservations are fenced by setting expiry to zero before R2 deletion. Ordinary cleanup records are removed only after successful R2 deletion; currently referenced keys drop their redundant cleanup record. Failures increment attempts, retain diagnostics and retry after `min(15 minutes × attempts, 24 hours)`.
4. Run the bounded size backfill described above and report updated/missing/failed counts.

Account/attachment deletion and import replacement write cleanup records in the same D1 operation that removes references, then attempt R2 deletion after commit. Import attempts one queued blob promptly to stay within its conservative invocation budget; cron handles the rest. Records have no user FK and survive account deletion. Settled failed uploads release reservations and attempt cleanup; abandoned expired uploads retain reservation/cleanup tombstones and retry successful deletes daily indefinitely. Do not prune tombstones just because a blob is missing or a delete succeeded: a late R2 put can otherwise become untracked.

For a local trigger, run `npx wrangler dev --test-scheduled`, then:

```bash
curl 'http://localhost:8787/__scheduled?cron=*/15+*+*+*+*'
```

Inspect count summaries and the private queue for persistent failures. This local trigger is not hosted Cron verification.

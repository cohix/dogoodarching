# Operations

## Installing and running

Installation:

- Use the [README quick start](../../README.md#quick-start) to install dependencies, authenticate Wrangler, create D1/R2 and replace the placeholder `database_id` values. Resource names/bindings are in [infrastructure](infrastructure.md#architecture).

Setup and run:

- Apply migrations to the intended environment, build the SPA, then run/deploy the Worker. Fresh databases have no seeded account; follow [first run](../../README.md#first-run-accounts-roles-invites).
- The [hosted password-hashing blocker](../architecture/security.md#api-security) remains until work item 0002. A successful build/deploy does not establish that hosted signup/login works.

Environment variables:

- None required by the application today. `DB` and `ATTACHMENTS` are resource bindings, not string environment variables. CI/tooling sets `WRANGLER_SEND_METRICS=false`.

Secrets:

- No Worker secrets today. Work item 0002 adds bindings rather than a bootstrap secret; the public-bootstrap risk remains accepted. If a future change introduces a Worker secret, provision it using `npx wrangler secret put SECRET_NAME` (production) and `npx wrangler secret put SECRET_NAME --env preview`, and document the real name here then.
- GitHub environment secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` belong separately to `preview` and `production`. The token needs account-scoped Workers Scripts: Edit, D1: Edit and Workers R2 Storage: Edit for deploy/migration/binding validation. These are CI credentials, not Worker bindings. Local operators authenticate with `wrangler login`.

## Environments

Preview and production run the same application with independent storage. Top-level Wrangler configuration is production; `--env preview` selects preview. The [workflow behavior](cicd.md#pipelines) defines automation and approval.

| Target | Apply migrations | Build and deploy |
|---|---|---|
| Local | `npm run db:migrate:local` | `npm run build && npm run dev` |
| Preview | `npm run db:migrate:preview` | `npm run deploy:preview` |
| Production | `npm run db:migrate` | `npm run deploy` |

Direct deploy scripts do not migrate or require GitHub approval. Routine releases use CI, which supplies the SHA tag and applies migrations first.

## Ongoing operations

Version upgrades/downgrades:

- Change dependencies and the lockfile together; review compatibility before changing `compatibility_date`. Run typecheck, lint, tests, schema check and build, then deploy to preview and exercise hosted auth, uploads and the PWA before production.
- Worker rollback to an earlier SHA does not reverse database migrations or R2 changes. Confirm schema compatibility first; prefer a corrective forward migration over editing history.

Database migrations:

1. Edit `src/db/schema.ts`, then run `npm run db:generate` (drizzle-kit with SQLite/d1-http). Commit the reviewed new SQL and `migrations/meta` snapshot/journal together. Never edit an applied migration.
2. Review generated SQL, especially table rebuilds, FK cascades, data copying and D1 limits. Existing migrations are `0001_init.sql` and `0002_team_auth.sql`. The second uses deferred FK checks, preserves valid rows and score ends, discards user-owned orphan rows, nulls broken inviter references, marks the earliest existing coach owner, and removes `entries`. Existing program states stay unchanged; missing states are backfilled to 24 lb / cycle 2 / week 6 with a migration-time anchor, preserving the old display at migration time. New accounts use the neutral default.
3. Run `npm run db:check`. This invokes generation and fails if migration bytes change; it does not apply migrations. Apply locally with `npm run db:migrate:local` and run migration/integration tests against empty and seeded legacy schemas. Inspect a copy of populated data before destructive upgrades.
4. Back up the remote database before applying changes, for example `npx wrangler d1 export DB --remote --env preview --output preview-before-migration.sql`, or `npx wrangler d1 export DB --remote --output production-before-migration.sql`. Keep exports outside version control and protect them as account data.
5. Apply to preview first (CI does this on a merge/push to `main`), verify, then use the manual production workflow. Both workflows run migration commands before Worker deployment. They do **not** automate the backup step.
6. After migration, verify `PRAGMA foreign_key_check`, account access, program state and attachment metadata against expected results. Restore/recovery is described below.

## Backups & restore

D1 SQL export is the explicit pre-change backup. D1 Time Travel is the remote point-in-time recovery facility; use Wrangler's `d1 time-travel info` and `restore` commands with the selected environment and an inspected timestamp/bookmark. Confirm the account's available recovery window before relying on a restore; the repo defines no retention policy. A restore changes the whole selected database, so coordinate it with the deployed Worker/schema version.

R2 bytes need their own backup/recovery process: neither D1 Time Travel nor the app JSON export includes them. No R2 backup job, retention schedule or restore automation exists in this repository. A usable file restore must match D1 `blob_key` references to the restored R2 objects. Keep a copy of file bytes before operations that remove/replace them. See [current import ordering](../architecture/design.md#component-6) before importing over data with uploads.

## Logs

Use `npx wrangler tail` for production or `npx wrangler tail --env preview` for preview. Use Cloudflare Workers Logs when enabled in the account; no `[observability]` configuration is declared here. The global error handler logs `Unhandled error` with `console.error`. There is no application alerting or logging retention configuration. Invite tokens are currently in URL paths; the [planned fragment/header changes](../architecture/security.md#planned-work-item-0002) address that exposure.

## Admin runbook

The app has no password-change or recovery endpoint today. A Cloudflare/D1 operator can manually replace a password hash and revoke that user's sessions. App owner status alone does not grant this database access.

1. Back up the chosen database. Identify the exact user UUID with a read-only `wrangler d1 execute DB --remote --command "SELECT id, username, role, is_owner FROM users"` (add `--env preview` for preview).
2. Generate a hash locally with the checked-out application's `hashPassword`, so it matches the verifier. With Node 22, from the repository root:

   ```bash
   read -r -s -p 'New password: ' DGA_RESET_PASSWORD
   export DGA_RESET_PASSWORD
   node --experimental-strip-types --input-type=module <<'JS'
   import { hashPassword } from './src/lib/auth.ts';
   console.log(await hashPassword(process.env.DGA_RESET_PASSWORD));
   JS
   unset DGA_RESET_PASSWORD
   ```

3. Put the resulting hash and the verified UUID into a local SQL file (replace `GENERATED_HASH` and `USER_UUID`, retaining the SQL single quotes):

   ```sql
   UPDATE users SET password_hash = 'GENERATED_HASH' WHERE id = 'USER_UUID';
   DELETE FROM sessions WHERE user_id = 'USER_UUID';
   ```

4. Run `npx wrangler d1 execute DB --remote --file /path/to/reset.sql`, adding `--env preview` for preview, or use `--local` instead of `--remote` for local recovery. Verify the selected row was updated and sessions removed, test login, then remove the temporary hash/SQL file. The current hosted hashing blocker still applies; changing only the stored hash cannot fix it.

**Planned (work item 0002):** self-service password change with the current password, sign out everywhere and account lifecycle controls, described in [experience](../uxui/experience.md#signup-and-account). Forgotten-password reset without email remains a manual operator task.

## Scheduled cleanup jobs

No Cron Trigger or `scheduled` handler exists today. Sessions and used/expired invites are not periodically purged. Rate-limit windows reset on the next request for that key; inactive buckets are not periodically purged.

**Planned (work item 0002):** Cron Triggers in preview and production will delete expired sessions and invitations used or expired for more than 30 days. No trigger schedule is defined yet. The hardening item also calls for handling partial R2 deletion failures during account cleanup; no such retry job exists today.

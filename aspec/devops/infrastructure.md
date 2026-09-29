# Infrastructure

Deployment platform: Cloudflare Workers  
Cloud platform: Cloudflare  
Automation: Wrangler via `wrangler.toml`; no Terraform.

## Architecture:

Resources and bindings:

| Resource | Production (top-level config) | Preview (`[previews]`) |
|---|---|---|
| Worker | `dogoodarching` | `dogoodarching`, as Preview deployments (`wrangler preview`) |
| D1, binding `DB` | `dogoodarching` | `dogoodarching-preview` |
| R2, binding `ATTACHMENTS` | `dogoodarching-attachments` | `dogoodarching-attachments-preview` |
| Static Assets | `dist/client` | Same build directory/configuration |
| `RATE_LIMIT_5_PER_MIN` | namespace `1001`, 5 / 60 seconds | namespace `2001`, 5 / 60 seconds |
| `RATE_LIMIT_10_PER_MIN` | namespace `1002`, 10 / 60 seconds | namespace `2002`, 10 / 60 seconds |
| Cron Trigger | `*/15 * * * *` | None |

Rate Limiting bindings are declared in `[[ratelimits]]` and `[[previews.ratelimits]]`; distinct namespaces isolate counters. Operation selection and fail-closed behavior are in [security](../architecture/security.md#rate-limiting). `RATE_LIMIT_MODE` is absent from deployment configuration.

`[triggers]` configures cleanup every 15 minutes UTC (:00/:15/:30/:45) for production only. `[previews]` has no `triggers` key, so preview deployments run no scheduled cleanup: expired sessions/invites and pending R2 deletions accumulate in the preview database until they are cleaned up by hand. The `scheduled` handler and bounded job are described in [operations](operations.md#scheduled-cleanup-jobs).

Workers Static Assets has `not_found_handling = "single-page-application"` and `run_worker_first = ["/api/*"]`. No explicit `ASSETS` binding is declared. `frontend/public/_headers` applies the [security policy](../architecture/security.md#secrets) to `/*`, and Vite copies it unchanged to `dist/client/_headers`; it also participates in the shell cache hash. API responses receive headers separately from Hono. Verify static headers on `/`, `/invite` and SPA fallback through the deployed asset service; an API test or Vite server is not proof. Partial hosted results and remaining checks are recorded in [README](../../README.md#verification-status).

Best practices:

- Pin `compatibility_date` (currently `2026-09-25`) and follow the [upgrade procedure](operations.md#ongoing-operations).
- Keep environment storage/counters separate. D1 IDs are account-specific; see [README setup](../../README.md#1-create-the-d1-database). The preview D1 ID appears twice, in `[[previews.d1_databases]]` and as `preview_database_id` on the top-level `[[d1_databases]]` (read by `wrangler d1 ... --preview`); keep them equal.
- Account for Workers CPU/memory/body limits and D1 query/parameter/statement limits. Uploads stream with backpressure through a verified FixedLengthStream. Import uses a fixed 40-statement budget with room for authentication and bounded cleanup, valid on both Free and Paid plans; see [import limits](../architecture/security.md#import-hardening). No custom CPU limit is specified here.

Security and RBAC:

- Cloudflare account access belongs to the deployment operator; application ownership grants no Cloudflare access.
- Cloudflare (Workers Builds) deploys with credentials managed in the Cloudflare dashboard. GitHub Actions holds no Cloudflare credentials; see [CI/CD](cicd.md#pipelines).
- Keep R2 private and accessible only through Worker authorization. No public bucket/custom-domain configuration is declared here; account-side settings must preserve this boundary.

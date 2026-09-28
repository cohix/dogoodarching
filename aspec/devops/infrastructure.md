# Infrastructure

Deployment platform: Cloudflare Workers  
Cloud platform: Cloudflare  
Automation: Wrangler via `wrangler.toml`; no Terraform.

## Architecture:

Resources and bindings:

| Resource | Production (top-level config) | Preview (`env.preview`) |
|---|---|---|
| Worker | `do-good-arching` | `do-good-arching-preview` |
| D1, binding `DB` | `do-good-arching` | `do-good-arching-preview` |
| R2, binding `ATTACHMENTS` | `do-good-arching-attachments` | `do-good-arching-attachments-preview` |
| Static Assets | `dist/client` | Same build directory/configuration, separately deployed |

Workers Static Assets has `not_found_handling = "single-page-application"` and `run_worker_first = ["/api/*"]`. No explicit `ASSETS` binding is declared; platform routing handles the assets. There are no Cron Triggers or Rate Limiting bindings today.

**Planned (work item 0002):** declare Rate Limiting bindings and Cron Triggers separately for production and preview. Their behavior is described in [security](../architecture/security.md#planned-work-item-0002) and [operations](operations.md#scheduled-cleanup-jobs).

Best practices:

- Pin `compatibility_date` (currently `2026-09-25`). Test changes through the [upgrade procedure](operations.md#ongoing-operations).
- Keep preview and production storage separate. Both configured D1 IDs are account-specific placeholders until provisioned; see [README setup](../../README.md#1-create-the-d1-database).
- Account for Workers CPU/memory and request-body limits, PBKDF2 iteration limits, and D1 bound-parameter, statement/batch size and execution limits. Base64 uploads and large imports amplify these costs. The current application limits/gaps and hosted password blocker are in [security](../architecture/security.md); no deployment plan or custom CPU limit is specified in this repo.

Security and RBAC:

- Cloudflare account access is held by the deployment operator, outside application RBAC. The repo does not assign named account administrators; application ownership does not grant Cloudflare access.
- CI uses scoped credentials stored in GitHub environments, as detailed in [operations](operations.md#installing-and-running). Configure production required reviewers under repository environment settings.
- R2 buckets are intended to remain private and reachable by users only through Worker attachment authorization. No public bucket/custom-domain configuration is declared here; account-side settings must preserve that boundary.
